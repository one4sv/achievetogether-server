-- Calendar repeat rules, private completed-period snapshots and transactional rollover.
alter table public.at_goals
    add column repeat_frequency text not null default 'none' check (repeat_frequency in ('none','daily','weekly','monthly')),
    add column repeat_period_start date,
    add column repeat_next_at timestamptz;
create index at_goals_repeat_due on public.at_goals(repeat_next_at) where repeat_next_at is not null;
create table public.at_goal_periods (
    id bigint generated always as identity primary key,
    goal_id bigint not null references public.at_goals(id) on delete cascade,
    frequency text not null check (frequency in ('daily','weekly','monthly')),
    period_start date not null,
    period_end date not null check (period_end>=period_start),
    progress numeric(7,2) not null check (progress between 0 and 100),
    completed boolean not null,
    closed_at timestamptz not null default now(),
    unique(goal_id,frequency,period_start)
);
alter table public.at_goal_periods enable row level security;
revoke all on public.at_goal_periods from public,anon,authenticated;
grant select,insert,update,delete on public.at_goal_periods to service_role;
grant usage,select on sequence public.at_goal_periods_id_seq to service_role;

create function public.at_init_goal_repeat() returns trigger
language plpgsql security invoker set search_path='' as $$
declare zone text; day date; next_day date;
begin
    if tg_op='UPDATE' and new.repeat_frequency=old.repeat_frequency and new.due_date is not distinct from old.due_date then return new; end if;
    if new.repeat_frequency='none' then new.repeat_period_start:=null;new.repeat_next_at:=null;return new; end if;
    select timezone into zone from public.at_habit_reminder_preferences where user_id=new.owner_id;
    zone:=coalesce(zone,'UTC');
    day:=(now() at time zone zone)::date;
    next_day:=case new.repeat_frequency when 'daily' then day+1 when 'weekly' then (date_trunc('week',day::timestamp)+interval '7 days')::date else (date_trunc('month',day::timestamp)+interval '1 month')::date end;
    if tg_op='UPDATE' and new.repeat_frequency=old.repeat_frequency and old.repeat_period_start is not null then day:=old.repeat_period_start; end if;
    next_day:=case new.repeat_frequency when 'daily' then day+1 when 'weekly' then (date_trunc('week',day::timestamp)+interval '7 days')::date else (date_trunc('month',day::timestamp)+interval '1 month')::date end;
    if new.due_date is not null then next_day:=least(next_day,new.due_date+1); end if;
    new.repeat_period_start:=day;
    new.repeat_next_at:=case when next_day>day then next_day::timestamp at time zone zone else null end;
    return new;
end;
$$;
revoke all on function public.at_init_goal_repeat() from public,anon,authenticated;
grant execute on function public.at_init_goal_repeat() to service_role;
create trigger at_goal_init_repeat before insert or update of repeat_frequency,due_date on public.at_goals for each row execute function public.at_init_goal_repeat();

create or replace function public.at_update_goal_and_links(p_goal_id bigint,p_owner uuid,p_fields jsonb,p_habit_ids bigint[],p_plan_ids bigint[])
returns public.at_goals language plpgsql security invoker set search_path = '' as $$
declare g public.at_goals;
begin
    select * into g from public.at_goals where id=p_goal_id and owner_id=p_owner for update;
    if not found then raise exception 'Goal not found'; end if;
    if p_habit_ids is not null and exists(select 1 from unnest(p_habit_ids) as x(id) where not exists(select 1 from public.habits h where h.id=x.id and h.user_id=p_owner and (h.ongoing or exists(select 1 from public.at_goal_habit_links l where l.goal_id=p_goal_id and l.habit_id=h.id)))) then raise exception 'Invalid habit'; end if;
    if p_plan_ids is not null and exists(select 1 from unnest(p_plan_ids) as x(id) where not exists(select 1 from public.one_off_plans p where p.id=x.id and p.owner_id=p_owner and ((p.status='upcoming' and (p.plan_date>(now() at time zone coalesce((select timezone from public.at_habit_reminder_preferences where user_id=p_owner),'UTC'))::date or (p.plan_date=(now() at time zone coalesce((select timezone from public.at_habit_reminder_preferences where user_id=p_owner),'UTC'))::date and (coalesce(p.end_time,p.start_time) is null or coalesce(p.end_time,p.start_time)>date_trunc('minute',now() at time zone coalesce((select timezone from public.at_habit_reminder_preferences where user_id=p_owner),'UTC'))::time)))) or exists(select 1 from public.at_goal_plan_links l where l.goal_id=p_goal_id and l.plan_id=p.id)))) then raise exception 'Invalid plan'; end if;
    g := jsonb_populate_record(g,p_fields);
    update public.at_goals set name=g.name,description=g.description,due_date=g.due_date,progress_mode=g.progress_mode,status=g.status,
      manual_progress=g.manual_progress,metric_start=g.metric_start,metric_target=g.metric_target,metric_current=g.metric_current,
      repeat_frequency=g.repeat_frequency,metric_unit=g.metric_unit,metric_share=g.metric_share,target_days=g.target_days,daily_minutes=g.daily_minutes,auto_complete=g.auto_complete,reminder_days=g.reminder_days,
      completed_at=case when g.status='completed' then coalesce(g.completed_at,now()) else null end,
      auto_completed=case when p_fields ? 'status' or not g.auto_complete then false else g.auto_completed end,updated_at=now()
      where id=p_goal_id and owner_id=p_owner returning * into g;
    if p_habit_ids is not null then
        delete from public.at_goal_habit_links where goal_id=p_goal_id;
        insert into public.at_goal_habit_links(goal_id,habit_id) select p_goal_id,unnest(p_habit_ids);
    end if;
    if p_plan_ids is not null then
        delete from public.at_goal_plan_links where goal_id=p_goal_id;
        insert into public.at_goal_plan_links(goal_id,plan_id) select p_goal_id,unnest(p_plan_ids);
    end if;
    if g.progress_mode in ('days','streak','daily_timer','daily_counter','total_timer') and not exists(select 1 from public.at_goal_habit_links where goal_id=p_goal_id) then raise exception 'Activity required'; end if;
    if (p_habit_ids is not null or p_fields ? 'progress_mode') and g.progress_mode in ('daily_timer','total_timer','daily_counter') and exists (
        select 1 from public.at_goal_habit_links l where l.goal_id=p_goal_id and not exists (
            select 1 from public.habits_settings s where s.habit_id=l.habit_id and s.metric_type::text=case when g.progress_mode='daily_counter' then 'counter' else 'timer' end
        )
    ) then raise exception 'Incompatible activity metric'; end if;
    return g;
end;
$$;
revoke all on function public.at_update_goal_and_links(bigint,uuid,jsonb,bigint[],bigint[]) from public,anon,authenticated;
grant execute on function public.at_update_goal_and_links(bigint,uuid,jsonb,bigint[],bigint[]) to service_role;

create function public.at_roll_goal_period(p_goal_id bigint,p_owner uuid,p_expected_start date,p_expected_frequency text,p_next_start date,p_next_at timestamptz,p_progress numeric)
returns public.at_goals language plpgsql security invoker set search_path='' as $$
declare g public.at_goals; finished boolean;
begin
    select * into g from public.at_goals where id=p_goal_id and owner_id=p_owner for update;
    if not found or g.repeat_period_start is distinct from p_expected_start or g.repeat_frequency<>p_expected_frequency or g.repeat_next_at is null or g.status in ('archived','canceled') then return null; end if;
    if p_next_start<=p_expected_start or p_progress not between 0 and 100 then raise exception 'Invalid period'; end if;
    finished:=p_progress>=100 or g.status='completed';
    insert into public.at_goal_periods(goal_id,frequency,period_start,period_end,progress,completed)
        values(g.id,g.repeat_frequency,p_expected_start,p_next_start-1,p_progress,finished) on conflict(goal_id,frequency,period_start) do nothing;
    if p_next_at is null then
        update public.at_goals set repeat_next_at=null,last_progress=p_progress where id=g.id returning * into g;
        insert into public.at_goal_events(goal_id,actor_id,action,details) values(g.id,p_owner,'period_closed',jsonb_build_object('start',p_expected_start,'end',p_next_start-1,'progress',p_progress,'completed',finished));
        return g;
    end if;
    update public.at_goal_stages set completed_at=null where goal_id=g.id and completed_at is not null;
    update public.at_goals set repeat_period_start=p_next_start,repeat_next_at=p_next_at,manual_progress=0,metric_current=metric_start,
        last_progress=0,status=case when status='completed' then 'active' else status end,auto_completed=false,completed_at=null,updated_at=now()
        where id=g.id returning * into g;
    insert into public.at_goal_events(goal_id,actor_id,action,details)
        values(g.id,p_owner,'period_closed',jsonb_build_object('start',p_expected_start,'end',p_next_start-1,'progress',p_progress,'completed',finished));
    return g;
end;
$$;
revoke all on function public.at_roll_goal_period(bigint,uuid,date,text,date,timestamptz,numeric) from public,anon,authenticated;
grant execute on function public.at_roll_goal_period(bigint,uuid,date,text,date,timestamptz,numeric) to service_role;

create function public.at_record_goal_period_progress(p_goal_id bigint,p_owner uuid,p_progress numeric,p_expected_start date)
returns public.at_goals language plpgsql security invoker set search_path='' as $$
declare g public.at_goals;
begin
    select * into g from public.at_goals where id=p_goal_id and owner_id=p_owner for update;
    if not found or g.repeat_period_start is distinct from p_expected_start then return null; end if;
    return public.at_record_goal_progress(p_goal_id,p_owner,p_progress);
end;
$$;
revoke all on function public.at_record_goal_period_progress(bigint,uuid,numeric,date) from public,anon,authenticated;
grant execute on function public.at_record_goal_period_progress(bigint,uuid,numeric,date) to service_role;
