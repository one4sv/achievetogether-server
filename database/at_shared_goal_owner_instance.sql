-- Independent completion includes the activity owner; retain common progress separately.
create or replace function public.at_ensure_activity_goal_instance(p_template bigint,p_user uuid)
returns public.at_goals language plpgsql security invoker set search_path='' as $$
declare t public.at_goals; g public.at_goals; h public.habits;
begin
    select * into t from public.at_goals where id=p_template and shared_habit_id is not null and template_goal_id is null for update;
    if not found or t.status in ('archived','canceled') then return null; end if;
    select * into h from public.habits where id=t.shared_habit_id;
    if not found or h.goal_scope<>'shared' or h.goal_completion_mode<>'personal' or not coalesce((public.habit_permissions(p_user,h.id)->>'is_member')::boolean,false) then return null; end if;
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

