alter table public.one_off_plan_comments add column photo_ids uuid[] not null default '{}';
alter table public.one_off_plan_comments add constraint plan_comment_photo_limit check (cardinality(photo_ids)<=4);

create function private.track_plan_comment_images() returns trigger
language plpgsql security definer set search_path='' as $$
declare previous_ids uuid[]:='{}'; next_ids uuid[]:='{}'; pid bigint;
begin
    if tg_op<>'INSERT' then pid:=old.plan_id; previous_ids:=old.photo_ids; end if;
    if tg_op<>'DELETE' then pid:=new.plan_id; next_ids:=new.photo_ids; end if;
    insert into public.activity_image_cleanup(path,due_at)
        select 'plans/'||pid::text||'/comments/'||k::text||'.jpg',now() from unnest(previous_ids) k where not(k=any(next_ids))
        on conflict(path) do nothing;
    delete from public.activity_image_cleanup q where q.path in
        (select 'plans/'||pid::text||'/comments/'||k::text||'.jpg' from unnest(next_ids) k);
    return null;
end $$;
revoke all on function private.track_plan_comment_images() from public,anon,authenticated;
create trigger plan_comment_images_cleanup after insert or update of photo_ids or delete on public.one_off_plan_comments
for each row execute function private.track_plan_comment_images();

create function public.save_plan_comment_images(p_actor uuid,p_plan bigint,p_text text,p_expected uuid[],p_keep uuid[],p_new uuid[]) returns void
language plpgsql set search_path='' as $$
declare p public.one_off_plans; existing uuid[]; combined uuid[]:=p_keep||p_new;
begin
    select * into p from public.one_off_plans where id=p_plan for update;
    if not found or p.status='canceled' then raise exception 'Plan unavailable' using errcode='42501'; end if;
    if p.owner_id<>p_actor then
        perform 1 from public.one_off_plan_members where plan_id=p_plan and user_id=p_actor and status='accepted' for update;
        if not found then raise exception 'Not a member' using errcode='42501'; end if;
    end if;
    select photo_ids into existing from public.one_off_plan_comments where plan_id=p_plan and user_id=p_actor for update;
    if coalesce(existing,'{}') is distinct from p_expected then raise exception 'Photos changed' using errcode='40001'; end if;
    if p_text is null or char_length(p_text)>200 or not(p_keep <@ coalesce(existing,'{}')) or cardinality(combined)>4 or
        cardinality(combined)<>(select count(distinct k) from unnest(combined) k) then
        raise exception 'Invalid comment' using errcode='22023';
    end if;
    if btrim(p_text)='' and cardinality(combined)=0 then
        delete from public.one_off_plan_comments where plan_id=p_plan and user_id=p_actor;
    else
        insert into public.one_off_plan_comments(plan_id,user_id,comment,photo_ids,updated_at)
        values(p_plan,p_actor,p_text,combined,now())
        on conflict(plan_id,user_id) do update set comment=excluded.comment,photo_ids=excluded.photo_ids,updated_at=excluded.updated_at;
    end if;
end $$;
revoke all on function public.save_plan_comment_images(uuid,bigint,text,uuid[],uuid[],uuid[]) from public,anon,authenticated;
grant execute on function public.save_plan_comment_images(uuid,bigint,text,uuid[],uuid[],uuid[]) to service_role;
