-- Purge eligible accounts only after the entire 30-day grace window.
-- Shared conversations and other people's messages remain accessible.
create or replace function public.at_purge_expired_accounts()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    candidate record;
    affected integer := 0;
    private_chats bigint[];
begin
    for candidate in
        select id, deletion_delete_messages
        from public.users
        where deletion_requested_at is not null
          and deletion_requested_at <= clock_timestamp() - interval '30 days'
        order by deletion_requested_at
        limit 100
        for update skip locked
    loop
        begin
            select coalesce(array_agg(cm.chat_id), '{}'::bigint[])
            into private_chats
            from public.chat_members cm
            join public.chats c on c.id = cm.chat_id and c.is_group = false
            where cm.user_id = candidate.id;

            if candidate.deletion_delete_messages then
                delete from public.messages where sender_id = candidate.id;
            end if;
            update public.chats set creator_id = null where creator_id = candidate.id;
            delete from public.settings where user_id = candidate.id;
            delete from public.users where id = candidate.id;

            if array_length(private_chats, 1) is not null then
                delete from public.chats c
                where c.id = any(private_chats)
                  and not exists (
                      select 1 from public.chat_members cm where cm.chat_id = c.id
                  )
                  and not exists (
                      select 1 from public.habits h where h.chat_id = c.id
                  );
            end if;
            affected := affected + 1;
        exception when others then
            raise warning 'Account cleanup failed for user id %, SQLSTATE %', candidate.id, SQLSTATE;
        end;
    end loop;
    return affected;
end;
$$;
revoke all on function public.at_purge_expired_accounts() from public, anon, authenticated;
grant execute on function public.at_purge_expired_accounts() to service_role;

-- pg_cron is already installed in this Supabase project. A new job is created
-- only if absent, avoiding replacement of unrelated scheduled tasks.
do $$
begin
    if not exists(select 1 from cron.job where jobname = 'at-purge-expired-accounts') then
        perform cron.schedule('at-purge-expired-accounts', '0 * * * *',
            'select public.at_purge_expired_accounts()');
    end if;
end;
$$;
