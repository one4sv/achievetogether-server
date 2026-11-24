-- Explicit milestone percentages and accumulated timer goals; existing stage weights remain intact.
alter table public.at_goal_stages add column completion_percent numeric(5,2) check (completion_percent between 0 and 100);
alter table public.at_goals drop constraint at_goals_progress_mode_check;
alter table public.at_goals add constraint at_goals_progress_mode_check check (progress_mode in ('manual','metric','milestones','combined','days','streak','daily_timer','daily_counter','total_timer'));

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
      metric_unit=g.metric_unit,metric_share=g.metric_share,target_days=g.target_days,daily_minutes=g.daily_minutes,auto_complete=g.auto_complete,reminder_days=g.reminder_days,
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


create or replace function public.at_queue_goal_activity() returns trigger
language plpgsql security invoker set search_path='' as $$
declare hid bigint;
begin
    if TG_TABLE_NAME='habits' then
        if TG_OP='DELETE' then hid:=old.id; else hid:=new.id; end if;
    else
        if TG_OP='DELETE' then hid:=old.habit_id; else hid:=new.habit_id; end if;
    end if;
    insert into public.at_goal_dirty(goal_id,queued_at)
        select l.goal_id,clock_timestamp() from public.at_goal_habit_links l
        join public.at_goals g on g.id=l.goal_id where l.habit_id=hid
        and g.progress_mode in ('days','streak','daily_timer','daily_counter','total_timer')
        on conflict(goal_id) do update set queued_at=excluded.queued_at;
    return null;
end;
$$;

revoke all on function public.at_queue_goal_activity() from public,anon,authenticated;
grant execute on function public.at_queue_goal_activity() to service_role;
create trigger at_goal_dirty_metric_type after insert or update of metric_type or delete on public.habits_settings for each row execute function public.at_queue_goal_activity();
