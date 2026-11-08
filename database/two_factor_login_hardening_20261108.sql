-- Protect 2FA email login tokens from database disclosure and replay.
alter table public.auth_tokens
    add column if not exists attempts integer not null default 0
      check (attempts between 0 and 100);

create index if not exists auth_tokens_mail_created_idx
    on public.auth_tokens(mail,created_at desc);

create or replace function public.at_consume_auth_login_code(
    p_email text,
    p_code_hash text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    auth_row public.auth_tokens%rowtype;
    target record;
    now_at timestamptz := clock_timestamp();
begin
    select * into auth_row from public.auth_tokens
    where lower(mail)=lower(p_email)
    order by created_at desc
    limit 1 for update;
    if not found or auth_row.expires_at <= now_at then
        return jsonb_build_object('success',false,'reason','expired_or_missing');
    end if;
    if auth_row.attempts >= 5 then
        return jsonb_build_object('success',false,'reason','locked');
    end if;
    if auth_row.code <> p_code_hash then
        update public.auth_tokens set attempts=attempts+1 where id=auth_row.id;
        return jsonb_build_object('success',false,'reason','invalid');
    end if;

    select id,deletion_requested_at into target
    from public.users where lower(mail)=lower(p_email);
    if not found then return jsonb_build_object('success',false,'reason','invalid'); end if;
    if target.deletion_requested_at is not null then
        return jsonb_build_object('success',false,'reason','deletion_pending',
            'deadline', target.deletion_requested_at + interval '30 days');
    end if;
    delete from public.auth_tokens where id=auth_row.id;
    return jsonb_build_object('success',true,'user_id',target.id);
end;
$$;
revoke all on function public.at_consume_auth_login_code(text,text) from public,anon,authenticated;
grant execute on function public.at_consume_auth_login_code(text,text) to service_role;
