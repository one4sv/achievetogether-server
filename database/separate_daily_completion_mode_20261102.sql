-- Applied as separate_daily_completion_mode_20261102.
alter table public.habits add column if not exists completion_mode text not null default 'personal' check (completion_mode in ('personal', 'shared'));
-- For existing data only: initialize independently stored completion mode.
update public.habits set completion_mode = metric_progress_mode where completion_mode is distinct from metric_progress_mode;
CREATE OR REPLACE FUNCTION public.change_habit_counter(p_habit_id bigint, p_actor uuid, p_delta numeric, p_reset boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare h public.habits%rowtype; c public.habit_counters%rowtype; v_user uuid; v_completion_user uuid; v_min numeric; v_old numeric; v_new numeric; v_day date; v_stamp timestamptz;
begin
 if not public.habit_has_permission(p_actor,p_habit_id,'complete') then raise exception 'Completion permission denied' using errcode='42501'; end if;
 if p_actor is null or p_habit_id is null or (not p_reset and (p_delta is null or p_delta=0 or abs(p_delta)>1000000000)) then
   raise exception 'Invalid input' using errcode='22023';
 end if;
 select * into h from public.habits where id=p_habit_id;
 if not found then raise exception 'Activity not found' using errcode='22023'; end if;
 if h.user_id<>p_actor and not exists(select 1 from public.habit_members where habit_id=p_habit_id and user_id=p_actor and status='accepted') then
   raise exception 'Access denied' using errcode='42501';
 end if;
 v_user:=case when h.metric_progress_mode='shared' then h.user_id else p_actor end;
 v_completion_user:=case when h.completion_mode='shared' then h.user_id else p_actor end;
 perform pg_advisory_xact_lock(hashtextextended(p_habit_id::text || ':' || v_user::text,0));
 v_day := (now() at time zone 'Europe/Moscow')::date;
 select * into c from public.habit_counters where habit_id=p_habit_id and user_id=v_user and (created_at at time zone 'Europe/Moscow')::date=v_day order by created_at desc limit 1 for update;
 if not found then
   select coalesce(min_counter,0) into v_min from public.counter_settings where habit_id=p_habit_id;
   v_min:=coalesce(v_min,0);
   insert into public.habit_counters(habit_id,user_id,count,progression,min_count)
     values(p_habit_id,v_user,0,array[]::jsonb[],v_min) returning * into c;
 end if;
 v_old:=coalesce(c.count,0);
 v_new:=case when p_reset then 0 else greatest(0,v_old+p_delta) end;
 v_stamp:=clock_timestamp();
 if v_new<>v_old then
  update public.habit_counters set count=v_new,progression=coalesce(c.progression,array[]::jsonb[]) || array[jsonb_build_object('count',v_new-v_old,'time',v_stamp,'text','','actor_id',p_actor)]::jsonb[]
  where id=c.id;
 end if;
 if v_old<coalesce(c.min_count,0) and v_new>=coalesce(c.min_count,0) then
   if not exists(select 1 from public.habit_completions where habit_id=p_habit_id and user_id=v_completion_user and completed_at=v_day) then
     insert into public.habit_completions(habit_id,user_id,completed_at,is_user_marked) values(p_habit_id,v_completion_user,v_day,false);
   end if;
 elsif v_old>=coalesce(c.min_count,0) and v_new<coalesce(c.min_count,0) then
   delete from public.habit_completions where habit_id=p_habit_id and user_id=v_completion_user and completed_at=v_day and is_user_marked is not true;
 end if;
 return jsonb_build_object('count',v_new,'counter_id',c.id,'user_id',v_user);
end; $function$
;
