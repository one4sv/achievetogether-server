create or replace function public.at_replace_habit_reminder_rules(
    p_user_id uuid,
    p_habit_id bigint,
    p_rules jsonb
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules) > 9 then
        return false;
    end if;
    if not exists (
        select 1 from public.habits h
        where h.id = p_habit_id and (
          h.user_id = p_user_id or exists (
            select 1 from public.habit_members m
            where m.habit_id=h.id and m.user_id=p_user_id and m.status='accepted'
          )
        )
    ) then
        return false;
    end if;
    delete from public.at_habit_reminder_rules
      where user_id=p_user_id and habit_id=p_habit_id;
    insert into public.at_habit_reminder_rules(user_id,habit_id,code,minutes_before,fixed_time)
    select p_user_id,p_habit_id,
        item->>'code',
        coalesce((item->>'minutes_before')::integer,0),
        (item->>'fixed_time')::time
    from jsonb_array_elements(p_rules) item;
    return true;
end;
$$;
revoke all on function public.at_replace_habit_reminder_rules(uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.at_replace_habit_reminder_rules(uuid,bigint,jsonb) to service_role;