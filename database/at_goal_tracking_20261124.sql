-- Extend existing goals without rewriting or deleting any goal or activity.
alter table public.at_goals drop constraint at_goals_progress_mode_check;
alter table public.at_goals add constraint at_goals_progress_mode_check
    check (progress_mode in ('manual','metric','milestones','combined','days','streak','daily_timer'));
alter table public.at_goals
    add column tracking_habit_id bigint references public.habits(id) on delete set null,
    add column tracking_days integer not null default 30 check (tracking_days between 1 and 3660),
    add column tracking_minutes integer not null default 120 check (tracking_minutes between 1 and 1440),
    add column tracking_start date,
    add column tracking_timezone text not null default 'UTC' check (length(tracking_timezone) between 1 and 64);
-- Invoker-only atomic save; no direct access to the Data API for users.
create function public.at_goal_save(p_owner uuid,p_id bigint,p_fields jsonb,p_habits bigint[],p_plans bigint[],p_stages jsonb)
returns public.at_goals
language plpgsql security invoker set search_path = '' as $$
declare g public.at_goals;
begin
    if p_id is null then
        insert into public.at_goals(owner_id,name) values(p_owner,p_fields->>'name') returning * into g;
    else
        select * into g from public.at_goals where id=p_id and owner_id=p_owner for update;
        if not found then raise exception 'Goal not found'; end if;
    end if;
    g := jsonb_populate_record(g,p_fields);
    if g.tracking_habit_id is not null and not exists(select 1 from public.habits h where h.id=g.tracking_habit_id and h.user_id=p_owner) then
        raise exception 'Invalid tracking activity';
    end if;
    if p_habits is not null and exists(select 1 from unnest(p_habits) x where not exists(select 1 from public.habits h where h.id=x and h.user_id=p_owner)) then
        raise exception 'Invalid activity link';
    end if;
    if p_plans is not null and exists(select 1 from unnest(p_plans) x where not exists(select 1 from public.one_off_plans p where p.id=x and p.owner_id=p_owner)) then
        raise exception 'Invalid plan link';
    end if;
    if g.progress_mode in ('days','streak','daily_timer') and (g.tracking_habit_id is null or g.tracking_start is null) then
        raise exception 'Missing tracking activity';
    end if;
    if g.progress_mode='daily_timer' and not exists(select 1 from public.habits_settings s where s.habit_id=g.tracking_habit_id and s.metric_type='timer') then
        raise exception 'Timer activity required';
    end if;
    update public.at_goals set name=g.name,description=g.description,due_date=g.due_date,progress_mode=g.progress_mode,
        status=g.status,manual_progress=g.manual_progress,metric_start=g.metric_start,metric_target=g.metric_target,
        metric_current=g.metric_current,metric_unit=g.metric_unit,metric_share=g.metric_share,
        tracking_habit_id=g.tracking_habit_id,tracking_days=g.tracking_days,tracking_minutes=g.tracking_minutes,
        tracking_start=g.tracking_start,tracking_timezone=g.tracking_timezone,updated_at=now()
        where id=g.id and owner_id=p_owner returning * into g;
    if p_habits is not null then
        delete from public.at_goal_habit_links where goal_id=g.id and not(habit_id=any(p_habits));
        insert into public.at_goal_habit_links(goal_id,habit_id) select g.id,x from unnest(p_habits) x on conflict do nothing;
    end if;
    if g.tracking_habit_id is not null then
        insert into public.at_goal_habit_links(goal_id,habit_id) values(g.id,g.tracking_habit_id) on conflict do nothing;
    end if;
    if p_plans is not null then
        delete from public.at_goal_plan_links where goal_id=g.id and not(plan_id=any(p_plans));
        insert into public.at_goal_plan_links(goal_id,plan_id) select g.id,x from unnest(p_plans) x on conflict do nothing;
    end if;
    if p_id is null and p_stages is not null then
        insert into public.at_goal_stages(goal_id,title,weight,position)
        select g.id,stage->>'title',coalesce((stage->>'weight')::numeric,1),(pos-1)::integer
        from jsonb_array_elements(p_stages) with ordinality as x(stage,pos);
    end if;
    return g;
end;
$$;
revoke all on function public.at_goal_save(uuid,bigint,jsonb,bigint[],bigint[],jsonb) from public,anon,authenticated;
grant execute on function public.at_goal_save(uuid,bigint,jsonb,bigint[],bigint[],jsonb) to service_role;
