-- Store object keys before purging users. Actual storage removal must use the Supabase Storage API.
create table if not exists public.at_storage_cleanup_jobs (
    id bigint generated always as identity primary key,
    bucket_id text not null,
    object_path text not null,
    attempts integer not null default 0,
    state text not null default 'pending' check (state in ('pending','done','failed')),
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    unique (bucket_id,object_path)
);
create index if not exists at_storage_cleanup_jobs_pending_idx on public.at_storage_cleanup_jobs(created_at)
    where state = 'pending';
alter table public.at_storage_cleanup_jobs enable row level security;
revoke all on public.at_storage_cleanup_jobs from anon, authenticated;
grant all on public.at_storage_cleanup_jobs to service_role;

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

            -- Queue object storage cleanup before database references disappear.
            -- Do not touch message attachments if the user chose to retain history.
            insert into public.at_storage_cleanup_jobs(bucket_id,object_path)
            select o.bucket_id,o.name
            from storage.objects o
            where
                (o.bucket_id = 'posts' and left(o.name,length(candidate.id::text || '/')) = candidate.id::text || '/') or
                (o.bucket_id = 'avatars' and left(o.name,length('user_' || candidate.id::text || '_')) = 'user_' || candidate.id::text || '_') or
                (o.bucket_id = 'bgs' and left(o.name,length('user_' || candidate.id::text || '_bg_')) = 'user_' || candidate.id::text || '_bg_') or
                (candidate.deletion_delete_messages and o.bucket_id = 'media'
                    and left(o.name,length(candidate.id::text || '/')) = candidate.id::text || '/')
            on conflict (bucket_id,object_path) do nothing;

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
