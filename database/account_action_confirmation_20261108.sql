-- Atomic use of single-use email action codes. Callable only by the server's service role.
create unique index if not exists users_email_ci_unique on public.users (lower(mail));

create or replace function public.at_consume_account_action(
    p_user_id uuid,
    p_action text,
    p_code_hash text,
    p_delete_messages boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row public.at_account_actions%rowtype;
    v_now timestamptz := clock_timestamp();
begin
    select * into v_row from public.at_account_actions
    where user_id = p_user_id and action = p_action and consumed_at is null
    order by created_at desc limit 1 for update;

    if not found or v_row.expires_at <= v_now then
        return jsonb_build_object('success', false, 'reason', 'expired');
    end if;
    if v_row.attempts >= 5 then
        return jsonb_build_object('success', false, 'reason', 'attempts');
    end if;
    if v_row.code_hash <> p_code_hash then
        update public.at_account_actions set attempts = attempts + 1 where id = v_row.id;
        return jsonb_build_object('success', false, 'reason', 'invalid');
    end if;

    if p_action = 'email_change' then
        if exists(select 1 from public.users where lower(mail) = lower(v_row.target_email) and id <> p_user_id) then
            return jsonb_build_object('success', false, 'reason', 'email_taken');
        end if;
        update public.users set mail = lower(v_row.target_email),
            auth_version = auth_version + 1 where id = p_user_id and deletion_requested_at is null;
        if not found then return jsonb_build_object('success',false,'reason','unavailable'); end if;
    elsif p_action = 'delete' then
        update public.users set deletion_requested_at = v_now,
            deletion_delete_messages = p_delete_messages,
            auth_version = auth_version + 1
        where id = p_user_id and deletion_requested_at is null;
        if not found then return jsonb_build_object('success',false,'reason','unavailable'); end if;
    elsif p_action = 'recover' then
        update public.users set deletion_requested_at = null,
            deletion_delete_messages = false,
            auth_version = auth_version + 1
        where id = p_user_id and deletion_requested_at is not null
        and deletion_requested_at > v_now - interval '30 days';
        if not found then return jsonb_build_object('success',false,'reason','unavailable'); end if;
    else
        return jsonb_build_object('success',false,'reason','invalid_action');
    end if;

    update public.at_account_actions set consumed_at = v_now where id = v_row.id;
    update public.at_user_sessions set revoked_at = v_now
        where user_id = p_user_id and revoked_at is null;
    delete from public.at_trusted_devices where user_id = p_user_id;

    return jsonb_build_object('success', true, 'action', p_action,
        'deadline', case when p_action = 'delete' then v_now + interval '30 days' else null end);
end;
$$;
revoke all on function public.at_consume_account_action(uuid,text,text,boolean)
    from public, anon, authenticated;
grant execute on function public.at_consume_account_action(uuid,text,text,boolean)
    to service_role;
