-- Applied to Supabase project on 2026-11-08.
-- The common reminder is generated once per user and local calendar day.
-- Keep the existing activity-linked queue for compatibility with older workers.
alter table public.at_habit_reminder_jobs
    add column if not exists common_day date;

create unique index if not exists at_habit_reminder_jobs_common_once_daily
    on public.at_habit_reminder_jobs(user_id,common_day)
    where reminder_code='common' and common_day is not null;

create or replace function public.at_enqueue_due_habit_reminders()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    prefs record;
    h public.habits%rowtype;
    rule record;
    local_minute timestamp;
    event_date date;
    event_time text;
    time_offset integer;
    fired_at timestamp;
    new_jobs integer := 0;
    added integer;
    day_shift integer;
begin
    for prefs in
        select p.*,s.all_note from public.at_habit_reminder_preferences p
        join public.users u on u.id = p.user_id and u.deletion_requested_at is null
        join public.settings s on s.user_id = p.user_id
        where p.enabled and s.all_note is distinct from false
          and exists(select 1 from public.at_push_subscriptions sub where sub.user_id = p.user_id)
    loop
        begin
            local_minute := date_trunc('minute',clock_timestamp() at time zone prefs.timezone);
        exception when invalid_parameter_value then
            continue;
        end;

        -- One shared reminder for the local day, regardless of activity count.
        if prefs.common_enabled and local_minute::time = prefs.common_time then
            select h2.* into h from public.habits h2
            where h2.ongoing is true
              and (h2.user_id = prefs.user_id or exists (
                  select 1 from public.habit_members m
                  where m.habit_id = h2.id and m.user_id = prefs.user_id and m.status = 'accepted'
              ))
              and public.at_reminder_active_day(h2,local_minute::date)
            order by h2.id
            limit 1;

            if found then
                insert into public.at_habit_reminder_jobs(user_id,habit_id,reminder_code,due_at,common_day)
                values(prefs.user_id,h.id,'common',date_trunc('minute',clock_timestamp()),local_minute::date)
                on conflict do nothing;
                get diagnostics added = row_count;
                new_jobs := new_jobs + added;
            end if;
        end if;

        for h in
            select h2.* from public.habits h2
            where h2.ongoing is true
              and (h2.user_id = prefs.user_id or exists (
                  select 1 from public.habit_members m
                  where m.habit_id = h2.id and m.user_id = prefs.user_id and m.status = 'accepted'
              ))
        loop
            for rule in
                select * from public.at_habit_reminder_rules
                where user_id = prefs.user_id and habit_id = h.id
            loop
                event_time := case
                    when rule.code = 'inp' then to_char(rule.fixed_time,'HH24:MI')
                    when rule.code in ('start','inpstart','10start','60start') then h.start_time
                    else h.end_time
                end;
                if event_time is null or event_time !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then
                    continue;
                end if;
                time_offset := rule.minutes_before;

                for day_shift in 0..1 loop
                    event_date := local_minute::date + day_shift;
                    if not public.at_reminder_active_day(h,event_date) then continue; end if;
                    fired_at := (event_date + event_time::time) -
                        make_interval(mins => time_offset);
                    if fired_at = local_minute then
                        insert into public.at_habit_reminder_jobs(user_id,habit_id,reminder_code,due_at)
                        values(prefs.user_id,h.id,rule.code,date_trunc('minute',clock_timestamp()))
                        on conflict do nothing;
                        get diagnostics added = row_count;
                        new_jobs := new_jobs + added;
                    end if;
                end loop;
            end loop;
        end loop;
    end loop;
    return new_jobs;
end;
$$;

revoke all on function public.at_enqueue_due_habit_reminders() from public,anon,authenticated;
grant execute on function public.at_enqueue_due_habit_reminders() to service_role;
