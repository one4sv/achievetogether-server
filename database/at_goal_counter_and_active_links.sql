alter table public.at_goals drop constraint at_goals_progress_mode_check;
alter table public.at_goals add constraint at_goals_progress_mode_check check (progress_mode in ('manual','metric','milestones','combined','days','streak','daily_timer','daily_counter'));
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
      metric_unit=g.metric_unit,metric_share=g.metric_share,target_days=g.target_days,daily_minutes=g.daily_minutes,updated_at=now()
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
