create schema if not exists private;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('activity-images','activity-images',false,800000,array['image/jpeg'])
on conflict (id) do nothing;

alter table public.habits add column if not exists avatar_key uuid;
alter table public.completions_comments add column if not exists photo_ids uuid[] not null default '{}';
create table if not exists public.activity_image_cleanup (
    path text primary key, due_at timestamptz not null
);
alter table public.activity_image_cleanup enable row level security;
revoke all on public.activity_image_cleanup from public, anon, authenticated;
grant select,insert,update,delete on public.activity_image_cleanup to service_role;
create index if not exists activity_image_cleanup_due on public.activity_image_cleanup(due_at);

create or replace function private.track_activity_images() returns trigger
language plpgsql security definer set search_path='' as $$
declare previous_ids uuid[] := '{}'; next_ids uuid[] := '{}'; hid bigint;
begin
    if tg_table_name='habits' then
        if tg_op<>'INSERT' then hid:=old.id; previous_ids:=array_remove(array[old.avatar_key],null); end if;
        if tg_op<>'DELETE' then hid:=new.id; next_ids:=array_remove(array[new.avatar_key],null); end if;
    else
        if tg_op<>'INSERT' then hid:=old.habit_id; previous_ids:=old.photo_ids; end if;
        if tg_op<>'DELETE' then hid:=new.habit_id; next_ids:=new.photo_ids; end if;
    end if;
    insert into public.activity_image_cleanup(path,due_at)
        select hid::text||'/'||k::text||'.jpg', now() from unnest(previous_ids) k where not(k=any(next_ids))
        on conflict(path) do nothing;
    delete from public.activity_image_cleanup q where q.path in
        (select hid::text||'/'||k::text||'.jpg' from unnest(next_ids) k);
    return null;
end $$;
create trigger activity_avatar_cleanup after insert or update of avatar_key or delete on public.habits
for each row execute function private.track_activity_images();
create trigger activity_comment_cleanup after insert or update of photo_ids or delete on public.completions_comments
for each row execute function private.track_activity_images();

create or replace function public.save_activity_comment_images(p_actor uuid,p_habit bigint,p_date date,p_text text,
    p_expected uuid[],p_keep uuid[],p_new uuid[]) returns void
language plpgsql set search_path='' as $$
declare existing uuid[]; combined uuid[]:=p_keep||p_new;
begin
    perform 1 from public.habits where id=p_habit and ongoing for update;
    if not found then raise exception 'Activity unavailable' using errcode='42501'; end if;
    select photo_ids into existing from public.completions_comments where habit_id=p_habit and user_id=p_actor and date=p_date;
    if coalesce(existing,'{}') is distinct from p_expected then raise exception 'Photos changed' using errcode='40001'; end if;
    if not(p_keep <@ coalesce(existing,'{}')) or cardinality(combined)>4 or
        cardinality(combined)<>(select count(distinct k) from unnest(combined) k) then
        raise exception 'Invalid photos' using errcode='22023';
    end if;
    perform public.save_habit_day_comment(p_actor,p_habit,p_date,p_text);
    update public.completions_comments set photo_ids=combined where habit_id=p_habit and user_id=p_actor and date=p_date;
end $$;
revoke all on function public.save_activity_comment_images(uuid,bigint,date,text,uuid[],uuid[],uuid[]) from public,anon,authenticated;
grant execute on function public.save_activity_comment_images(uuid,bigint,date,text,uuid[],uuid[],uuid[]) to service_role;

