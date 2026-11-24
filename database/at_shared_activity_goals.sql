-- Explicitly shared goal definition; never publish existing personal goals implicitly.
alter table public.habits
    add column goal_scope text not null default 'personal' check (goal_scope in ('personal','shared')),
    add column goal_completion_mode text not null default 'shared' check (goal_completion_mode in ('personal','shared'));
alter table public.at_goals
    add column shared_habit_id bigint references public.habits(id) on delete cascade,
    add column template_goal_id bigint references public.at_goals(id) on delete cascade,
    add constraint at_goal_instance_requires_habit check (template_goal_id is null or shared_habit_id is not null);
create unique index at_goal_single_shared_definition on public.at_goals(shared_habit_id) where shared_habit_id is not null and template_goal_id is null;
create unique index at_goal_one_instance_per_user on public.at_goals(template_goal_id,owner_id) where template_goal_id is not null;
alter table public.at_goal_stages add column template_stage_id bigint references public.at_goal_stages(id) on delete cascade;
create unique index at_goal_instance_stage on public.at_goal_stages(goal_id,template_stage_id) where template_stage_id is not null;

-- An instance holds private execution state but shares the definition. Lock the
-- definition before creating/syncing the instance so concurrent requests coalesce.
create function public.at_ensure_activity_goal_instance(p_template bigint,p_user uuid)
returns public.at_goals language plpgsql security invoker set search_path='' as $$
declare t public.at_goals; g public.at_goals; h public.habits;
begin
    select * into t from public.at_goals where id=p_template and shared_habit_id is not null and template_goal_id is null for update;
    if not found then return null; end if;
    select * into h from public.habits where id=t.shared_habit_id;
    if not found or h.goal_scope<>'shared' or h.goal_completion_mode<>'personal' or not coalesce((public.habit_permissions(p_user,h.id)->>'is_member')::boolean,false) then return null; end if;
    if t.owner_id=p_user then return t; end if;
    select * into g from public.at_goals where template_goal_id=t.id and owner_id=p_user for update;
    if not found then
        insert into public.at_goals(owner_id,shared_habit_id,template_goal_id,name,description,due_date,progress_mode,metric_start,metric_target,metric_current,metric_unit,metric_share,target_days,daily_minutes,auto_complete,repeat_frequency)
            values(p_user,h.id,t.id,t.name,t.description,t.due_date,t.progress_mode,t.metric_start,t.metric_target,t.metric_start,t.metric_unit,t.metric_share,t.target_days,t.daily_minutes,t.auto_complete,t.repeat_frequency)
            returning * into g;
        insert into public.at_goal_habit_links(goal_id,habit_id) values(g.id,h.id) on conflict do nothing;
    else
        update public.at_goals set name=t.name,description=t.description,due_date=t.due_date,progress_mode=t.progress_mode,
            metric_start=t.metric_start,metric_target=t.metric_target,metric_unit=t.metric_unit,metric_share=t.metric_share,target_days=t.target_days,daily_minutes=t.daily_minutes,
            auto_complete=t.auto_complete,repeat_frequency=t.repeat_frequency,updated_at=now()
            where id=g.id and (name,description,due_date,progress_mode,metric_start,metric_target,metric_unit,metric_share,target_days,daily_minutes,auto_complete,repeat_frequency)
                is distinct from (t.name,t.description,t.due_date,t.progress_mode,t.metric_start,t.metric_target,t.metric_unit,t.metric_share,t.target_days,t.daily_minutes,t.auto_complete,t.repeat_frequency);
        select * into g from public.at_goals where id=g.id;
    end if;
    insert into public.at_goal_stages(goal_id,title,weight,position,completion_percent,template_stage_id)
        select g.id,s.title,s.weight,s.position,s.completion_percent,s.id from public.at_goal_stages s where s.goal_id=t.id
        on conflict(goal_id,template_stage_id) where template_stage_id is not null do update
            set title=excluded.title,weight=excluded.weight,position=excluded.position,completion_percent=excluded.completion_percent
            where (at_goal_stages.title,at_goal_stages.weight,at_goal_stages.position,at_goal_stages.completion_percent)
              is distinct from (excluded.title,excluded.weight,excluded.position,excluded.completion_percent);
    return g;
end;
$$;
revoke all on function public.at_ensure_activity_goal_instance(bigint,uuid) from public,anon,authenticated;
grant execute on function public.at_ensure_activity_goal_instance(bigint,uuid) to service_role;

create or replace function public.at_update_goal_and_links(p_goal_id bigint,p_owner uuid,p_fields jsonb,p_habit_ids bigint[],p_plan_ids bigint[])
returns public.at_goals language plpgsql security invoker set search_path = '' as $$
declare g public.at_goals;
begin
    select * into g from public.at_goals where id=p_goal_id and owner_id=p_owner for update;
    if not found then raise exception 'Goal not found'; end if;
    if p_habit_ids is not null and exists(select 1 from unnest(p_habit_ids) as x(id) where not exists(select 1 from public.habits h where h.id=x.id and (h.user_id=p_owner or ((public.habit_permissions(p_owner,h.id)->>'is_member')::boolean and (h.goal_scope='personal' or exists(select 1 from public.at_goal_habit_links l where l.goal_id=p_goal_id and l.habit_id=h.id)))) and (h.ongoing or exists(select 1 from public.at_goal_habit_links l where l.goal_id=p_goal_id and l.habit_id=h.id)))) then raise exception 'Invalid habit'; end if;
    if p_plan_ids is not null and exists(select 1 from unnest(p_plan_ids) as x(id) where not exists(select 1 from public.one_off_plans p where p.id=x.id and p.owner_id=p_owner and ((p.status='upcoming' and (p.plan_date>(now() at time zone coalesce((select timezone from public.at_habit_reminder_preferences where user_id=p_owner),'UTC'))::date or (p.plan_date=(now() at time zone coalesce((select timezone from public.at_habit_reminder_preferences where user_id=p_owner),'UTC'))::date and (coalesce(p.end_time,p.start_time) is null or coalesce(p.end_time,p.start_time)>date_trunc('minute',now() at time zone coalesce((select timezone from public.at_habit_reminder_preferences where user_id=p_owner),'UTC'))::time)))) or exists(select 1 from public.at_goal_plan_links l where l.goal_id=p_goal_id and l.plan_id=p.id)))) then raise exception 'Invalid plan'; end if;
    if g.shared_habit_id is not null and ((p_habit_ids is not null and (cardinality(p_habit_ids)<>1 or p_habit_ids[1]<>g.shared_habit_id)) or (p_plan_ids is not null and cardinality(p_plan_ids)>0)) then raise exception 'Shared goal links are fixed'; end if;
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


