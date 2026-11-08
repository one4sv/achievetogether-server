-- Email-verified 2FA lifecycle; existing accounts are left unchanged.
alter table public.at_account_actions
    drop constraint if exists at_account_actions_action_check;
alter table public.at_account_actions
    add constraint at_account_actions_action_check
    check (action in ('delete','recover','email_change','two_factor','two_factor_backup'));
alter table public.at_account_actions
    add column if not exists target_two_factor boolean;

create or replace function public.at_confirm_two_factor(
    p_user_id uuid,
    p_action text,
    p_token_hash text,
    p_recovery_hashes text[] default '{}'::text[]
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    action_row public.at_account_actions%rowtype;
    current_value boolean;
    now_at timestamptz := clock_timestamp();
begin
    if p_action not in ('two_factor','two_factor_backup') then
        return jsonb_build_object('success',false,'reason','invalid_action');
    end if;
    select * into action_row
    from public.at_account_actions
    where user_id = p_user_id and action = p_action and consumed_at is null
    order by created_at desc limit 1 for update;
    if not found or action_row.expires_at <= now_at then
        return jsonb_build_object('success',false,'reason','expired');
    end if;
    if action_row.attempts >= 5 then
        return jsonb_build_object('success',false,'reason','attempts');
    end if;
    if action_row.code_hash <> p_token_hash then
        update public.at_account_actions set attempts = attempts + 1 where id = action_row.id;
        return jsonb_build_object('success',false,'reason','invalid');
    end if;
    select two_auth into current_value from public.settings where user_id = p_user_id for update;
    if not found then return jsonb_build_object('success',false,'reason','settings_missing'); end if;

    if p_action = 'two_factor_backup' and current_value is not true then
        return jsonb_build_object('success',false,'reason','not_enabled');
    end if;
    if p_action = 'two_factor' and action_row.target_two_factor is distinct from not current_value then
        return jsonb_build_object('success',false,'reason','stale');
    end if;
    if (p_action = 'two_factor_backup' or action_row.target_two_factor = true)
      and (cardinality(p_recovery_hashes) <> 10 or
           exists(select 1 from unnest(p_recovery_hashes) h where length(h) <> 64)) then
        return jsonb_build_object('success',false,'reason','invalid_recovery_codes');
    end if;

    if p_action = 'two_factor' then
        update public.settings set two_auth = action_row.target_two_factor where user_id = p_user_id;
    end if;
    delete from public.at_2fa_recovery_codes where user_id = p_user_id;
    if p_action = 'two_factor_backup' or action_row.target_two_factor then
        insert into public.at_2fa_recovery_codes (user_id,code_hash)
        select p_user_id, hash_value from unnest(p_recovery_hashes) hash_value;
    end if;
    update public.at_account_actions set consumed_at = now_at where id = action_row.id;
    update public.users set auth_version = auth_version + 1 where id = p_user_id
      and deletion_requested_at is null;
    if not found then return jsonb_build_object('success',false,'reason','unavailable'); end if;
    update public.at_user_sessions set revoked_at = now_at
      where user_id = p_user_id and revoked_at is null;
    delete from public.at_trusted_devices where user_id = p_user_id;
    return jsonb_build_object('success',true,'enabled',
      case when p_action = 'two_factor_backup' then true else action_row.target_two_factor end);
end;
$$;
revoke all on function public.at_confirm_two_factor(uuid,text,text,text[]) from public,anon,authenticated;
grant execute on function public.at_confirm_two_factor(uuid,text,text,text[]) to service_role;

-- Atomic use of recovery credentials, preventing two concurrent logins with the same code.
create or replace function public.at_use_2fa_recovery_code(p_user_id uuid,p_code_hash text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    changed uuid;
begin
    update public.at_2fa_recovery_codes set used_at = clock_timestamp()
    where user_id = p_user_id and code_hash = p_code_hash and used_at is null
    returning id into changed;
    return changed is not null;
end;
$$;
revoke all on function public.at_use_2fa_recovery_code(uuid,text) from public,anon,authenticated;
grant execute on function public.at_use_2fa_recovery_code(uuid,text) to service_role;
