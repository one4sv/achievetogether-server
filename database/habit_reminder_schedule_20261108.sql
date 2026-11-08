-- Per-user push reminder preferences, per-activity reminders and a durable queue.
create table if not exists public.at_habit_reminder_preferences (
    user_id uuid primary key references public.users(id) on delete cascade,
    enabled boolean not null default false,
    common_enabled boolean not null default true,
    common_time time not null default time '18:00',
    timezone text not null default 'UTC',
    updated_at timestamptz not null default now()
);
create table if not exists public.at_habit_reminder_rules (
    user_id uuid not null references public.users(id) on delete cascade,
    habit_id bigint not null references public.habits(id) on delete cascade,
    code text not null check (code in ('start','inpstart','10start','60start','inp','end','inpend','10end','60end')),
    minutes_before integer not null default 0 check (minutes_before between 0 and 1440),
    fixed_time time,
    primary key (user_id,habit_id,code)
);
create table if not exists public.at_habit_reminder_jobs (
    id bigint generated always as identity primary key,
    user_id uuid not null references public.users(id) on delete cascade,
    habit_id bigint not null references public.habits(id) on delete cascade,
    reminder_code text not null,
    due_at timestamptz not null,
    state text not null default 'pending'
        check (state in ('pending','processing','sent','skipped','failed')),
    attempts integer not null default 0,
    claimed_at timestamptz,
    completed_at timestamptz,
    error_code text,
    unique (user_id,habit_id,reminder_code,due_at)
);
create index if not exists at_habit_reminder_jobs_pending_idx
    on public.at_habit_reminder_jobs(due_at) where state in ('pending','processing');
alter table public.at_habit_reminder_preferences enable row level security;
alter table public.at_habit_reminder_rules enable row level security;
alter table public.at_habit_reminder_jobs enable row level security;
revoke all on public.at_habit_reminder_preferences,public.at_habit_reminder_rules,public.at_habit_reminder_jobs from anon,authenticated;
grant all on public.at_habit_reminder_preferences,public.at_habit_reminder_rules,public.at_habit_reminder_jobs to service_role;

create or replace function public.at_reminder_active_day(p_habit public.habits, p_day date)
returns boolean
language plpgsql stable
as $$
declare
    weekday integer := extract(isodow from p_day)::integer;
    active_days integer := greatest(1,coalesce(p_habit.cycle_days_active,1));
    rest_days integer := greatest(0,coalesce(p_habit.cycle_days_rest,1));
begin
    if p_day < p_habit.start_date or
       (p_habit.end_date is not null and p_day > p_habit.end_date) then return false; end if;
    if p_habit.periodicity = 'everyday' then return true; end if;
    if p_habit.periodicity = 'weekly' then
        return coalesce(p_habit.chosen_days,'[]'::jsonb) @> to_jsonb(weekday);
    end if;
    if p_habit.periodicity = 'cycle' then
        return ((p_day - p_habit.start_date) % (active_days + rest_days)) < active_days;
    end if;
    -- "sometimes" means no fixed day unless explicitly selected by the owner.
    if p_habit.periodicity = 'sometimes' then
        return coalesce(p_habit.chosen_days,'[]'::jsonb) @> to_jsonb(weekday);
    end if;
    return false;
end;
$$;

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

        for h in
            select h2.* from public.habits h2
            where h2.ongoing is true
              and (h2.user_id = prefs.user_id or exists (
                  select 1 from public.habit_members m
                  where m.habit_id = h2.id and m.user_id = prefs.user_id and m.status = 'accepted'
              ))
        loop
            if prefs.common_enabled and local_minute::time = prefs.common_time
                and public.at_reminder_active_day(h,local_minute::date) then
                insert into public.at_habit_reminder_jobs(user_id,habit_id,reminder_code,due_at)
                values(prefs.user_id,h.id,'common',date_trunc('minute',clock_timestamp()))
                on conflict do nothing;
                get diagnostics added = row_count;
                new_jobs := new_jobs + added;
            end if;

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

create or replace function public.at_claim_due_habit_reminder_jobs(p_limit integer default 50)
returns setof public.at_habit_reminder_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    return query
    with to_claim as (
        select id from public.at_habit_reminder_jobs
        where due_at between clock_timestamp() - interval '20 minutes' and clock_timestamp()
          and attempts < 3
          and (state='pending' or (state='processing' and claimed_at < clock_timestamp() - interval '2 minutes'))
        order by due_at,id limit least(greatest(p_limit,1),100)
        for update skip locked
    )
    update public.at_habit_reminder_jobs j
    set state='processing', claimed_at=clock_timestamp(), attempts=attempts+1
    from to_claim where j.id=to_claim.id returning j.*;
end;
$$;
revoke all on function public.at_claim_due_habit_reminder_jobs(integer) from public,anon,authenticated;
grant execute on function public.at_claim_due_habit_reminder_jobs(integer) to service_role;

do $$
begin
    if not exists(select 1 from cron.job where jobname = 'at-queue-habit-reminders') then
        perform cron.schedule('at-queue-habit-reminders','* * * * *',
            'select public.at_enqueue_due_habit_reminders()');
    end if;
end;
$$;
