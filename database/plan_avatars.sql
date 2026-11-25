alter table public.one_off_plans add column if not exists avatar_key uuid;
create or replace function private.track_plan_avatar() returns trigger
language plpgsql security definer set search_path='' as $$
declare previous_key uuid; next_key uuid; pid bigint;
begin
    if tg_op<>'INSERT' then pid:=old.id; previous_key:=old.avatar_key; end if;
    if tg_op<>'DELETE' then pid:=new.id; next_key:=new.avatar_key; end if;
    if previous_key is not null and previous_key is distinct from next_key then
        insert into public.activity_image_cleanup(path,due_at)
        values ('plans/'||pid::text||'/'||previous_key::text||'.jpg',now())
        on conflict(path) do nothing;
    end if;
    if next_key is not null then
        delete from public.activity_image_cleanup where path='plans/'||pid::text||'/'||next_key::text||'.jpg';
    end if;
    return null;
end $$;
revoke all on function private.track_plan_avatar() from public,anon,authenticated;
create trigger plan_avatar_cleanup after insert or update of avatar_key or delete on public.one_off_plans
for each row execute function private.track_plan_avatar();
