alter table public.at_goals add column auto_complete boolean not null default false,
    add column reminder_days integer check (reminder_days between 0 and 30),
    add column completed_at timestamptz,
    add column last_progress numeric(7,2) check (last_progress between 0 and 100),
    add column auto_completed boolean not null default false;
create table public.at_goal_reminder_deliveries (
    goal_id bigint not null references public.at_goals(id) on delete cascade,
    due_date date not null,
    reminder_days integer not null,
    created_at timestamptz not null default now(),
    primary key(goal_id,due_date,reminder_days)
);
alter table public.at_goal_reminder_deliveries enable row level security;
revoke all on public.at_goal_reminder_deliveries from anon,authenticated;
grant select,insert,delete on public.at_goal_reminder_deliveries to service_role;

-- Update calculated progress and history atomically, suppressing duplicate events.
create function public.at_record_goal_progress(p_goal_id bigint,p_owner uuid,p_progress numeric)
returns public.at_goals language plpgsql security invoker set search_path='' as $$
declare g public.at_goals; old_progress numeric; old_status text;
begin
    select * into g from public.at_goals where id=p_goal_id and owner_id=p_owner for update;
    if not found then return null; end if;
    old_progress := g.last_progress; old_status := g.status;
    if g.auto_complete and g.status='active' and p_progress>=100 then
        g.status:='completed'; g.auto_completed:=true; g.completed_at:=now();
    elsif g.auto_completed and g.status='completed' and p_progress<100 then
        g.status:='active'; g.auto_completed:=false; g.completed_at:=null;
    end if;
    if old_progress is distinct from p_progress or old_status<>g.status then
        update public.at_goals set last_progress=p_progress,status=g.status,auto_completed=g.auto_completed,completed_at=g.completed_at
            where id=p_goal_id and owner_id=p_owner returning * into g;
        insert into public.at_goal_events(goal_id,actor_id,action,details)
            values(p_goal_id,p_owner,'progress_changed',jsonb_build_object('from',old_progress,'to',p_progress));
        if old_status<>g.status then
            insert into public.at_goal_events(goal_id,actor_id,action,details)
                values(p_goal_id,p_owner,'auto_status',jsonb_build_object('status',g.status));
        end if;
    end if;
    return g;
end;
$$;
revoke all on function public.at_record_goal_progress(bigint,uuid,numeric) from public,anon,authenticated;
grant execute on function public.at_record_goal_progress(bigint,uuid,numeric) to service_role;
-- Atomic edit: apply only validated fields and replace links only when supplied.
create or replace function public.at_update_goal_and_links(p_goal_id bigint,p_owner uuid,p_fields jsonb,p_habit_ids bigint[],p_plan_ids bigint[])
returns public.at_goals language plpgsql security invoker set search_path = '' as $$
declare g public.at_goals;
begin
    select * into g from public.at_goals where id=p_goal_id and owner_id=p_owner for update;
    if not found then raise exception 'Goal not found'; end if;
    if p_habit_ids is not null and exists(select 1 from unnest(p_habit_ids) as x(id) where not exists(select 1 from public.habits h where h.id=x.id and h.user_id=p_owner and (h.ongoing or exists(select 1 from public.at_goal_habit_links l where l.goal_id=p_goal_id and l.habit_id=h.id)))) then raise exception 'Invalid habit'; end if;
    if p_plan_ids is not null and exists(select 1 from unnest(p_plan_ids) as x(id) where not exists(select 1 from public.one_off_plans p where p.id=x.id and p.owner_id=p_owner and ((p.status='upcoming' and (p.plan_date>(now() at time zone 'Europe/Moscow')::date or (p.plan_date=(now() at time zone 'Europe/Moscow')::date and (coalesce(p.end_time,p.start_time) is null or coalesce(p.end_time,p.start_time)>date_trunc('minute',now() at time zone 'Europe/Moscow')::time)))) or exists(select 1 from public.at_goal_plan_links l where l.goal_id=p_goal_id and l.plan_id=p.id)))) then raise exception 'Invalid plan'; end if;
    g := jsonb_populate_record(g,p_fields);
    update public.at_goals set name=g.name,description=g.description,due_date=g.due_date,progress_mode=g.progress_mode,status=g.status,
      manual_progress=g.manual_progress,metric_start=g.metric_start,metric_target=g.metric_target,metric_current=g.metric_current,
      metric_unit=g.metric_unit,metric_share=g.metric_share,target_days=g.target_days,daily_minutes=g.daily_minutes,auto_complete=g.auto_complete,reminder_days=g.reminder_days,
      completed_at=case when g.status='completed' then coalesce(g.completed_at,now()) else null end,
      auto_completed=case when p_fields ? 'status' then false else g.auto_completed end,updated_at=now()
      where id=p_goal_id and owner_id=p_owner returning * into g;
    if p_habit_ids is not null then
        delete from public.at_goal_habit_links where goal_id=p_goal_id;
        insert into public.at_goal_habit_links(goal_id,habit_id) select p_goal_id,unnest(p_habit_ids);
    end if;
    if p_plan_ids is not null then
        delete from public.at_goal_plan_links where goal_id=p_goal_id;
        insert into public.at_goal_plan_links(goal_id,plan_id) select p_goal_id,unnest(p_plan_ids);
    end if;
    if g.progress_mode in ('days','streak','daily_timer','daily_counter') and not exists(select 1 from public.at_goal_habit_links where goal_id=p_goal_id) then raise exception 'Activity required'; end if;
    return g;
end;
$$;
revoke all on function public.at_update_goal_and_links(bigint,uuid,jsonb,bigint[],bigint[]) from public,anon,authenticated;
grant execute on function public.at_update_goal_and_links(bigint,uuid,jsonb,bigint[],bigint[]) to service_role;
