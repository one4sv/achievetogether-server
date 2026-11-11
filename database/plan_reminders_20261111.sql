-- 0.6.4: independent, opt-in one-off plan reminders.
-- Do not touch existing habit reminder preferences or jobs.
create table if not exists public.at_plan_reminder_preferences (
    user_id uuid primary key references public.users(id) on delete cascade,
    enabled boolean not null default false,
    default_minutes_before integer not null default 60 check (default_minutes_before between 0 and 10080),
    updated_at timestamptz not null default now()
);
create table if not exists public.at_plan_reminder_rules (
    user_id uuid not null references public.users(id) on delete cascade,
    plan_id bigint not null references public.one_off_plans(id) on delete cascade,
    minutes_before integer not null check (minutes_before between 1 and 10080),
    created_at timestamptz not null default now(),
    primary key (user_id,plan_id,minutes_before)
);
create index if not exists at_plan_rules_plan on public.at_plan_reminder_rules(plan_id);
create table if not exists public.at_plan_reminder_jobs (
    id bigint generated always as identity primary key,
    user_id uuid not null references public.users(id) on delete cascade,
    plan_id bigint not null references public.one_off_plans(id) on delete cascade,
    rule_code text not null,
    minutes_before integer not null,
    due_at timestamptz not null,
    state text not null default 'pending'
        check (state in ('pending','processing','sent','skipped','failed')),
    attempts integer not null default 0,
    claimed_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    error_code text,
    unique (user_id,plan_id,rule_code,due_at)
);
create index if not exists at_plan_reminder_jobs_pending
    on public.at_plan_reminder_jobs(due_at) where state in ('pending','processing');
alter table public.at_plan_reminder_preferences enable row level security;
alter table public.at_plan_reminder_rules enable row level security;
alter table public.at_plan_reminder_jobs enable row level security;
revoke all on public.at_plan_reminder_preferences,public.at_plan_reminder_rules,public.at_plan_reminder_jobs from anon,authenticated;
grant select,insert,update,delete on public.at_plan_reminder_preferences,public.at_plan_reminder_rules,public.at_plan_reminder_jobs to service_role;
grant usage,select on sequence public.at_plan_reminder_jobs_id_seq to service_role;

create or replace function public.at_replace_plan_reminder_rules(
    p_user_id uuid, p_plan_id bigint, p_offsets integer[]
) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
    if not exists(
        select 1 from public.one_off_plans p
        where p.id=p_plan_id and
            (p.owner_id=p_user_id or exists(
                select 1 from public.one_off_plan_members m
                where m.plan_id=p.id and m.user_id=p_user_id and m.status='accepted'
            ))
    ) then return false; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':' || p_plan_id::text, 0));
    delete from public.at_plan_reminder_rules
        where user_id=p_user_id and plan_id=p_plan_id;
    insert into public.at_plan_reminder_rules(user_id,plan_id,minutes_before)
        select p_user_id,p_plan_id,v from unnest(p_offsets) as v;
    return true;
end;
$$;
revoke all on function public.at_replace_plan_reminder_rules(uuid,bigint,integer[]) from public,anon,authenticated;
grant execute on function public.at_replace_plan_reminder_rules(uuid,bigint,integer[]) to service_role;

create or replace function public.at_enqueue_due_plan_reminders()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
    entry record;
    chosen record;
    starts_at timestamptz;
    due_at timestamptz;
    added integer;
    total integer := 0;
begin
    for entry in
        select pref.user_id,pref.default_minutes_before,
            plan.id as plan_id,plan.plan_date,plan.start_time,plan.timezone
        from public.at_plan_reminder_preferences pref
        join public.users u on u.id=pref.user_id and u.deletion_requested_at is null
        join public.settings s on s.user_id=pref.user_id and s.all_note is distinct from false
        join public.one_off_plans plan on
            (plan.owner_id=pref.user_id or exists (
                select 1 from public.one_off_plan_members m
                where m.plan_id=plan.id and m.user_id=pref.user_id and m.status='accepted'
            ))
        where pref.enabled and plan.status='upcoming'
          and plan.plan_date between current_date-8 and current_date+8
          and exists(select 1 from public.at_push_subscriptions sub where sub.user_id=pref.user_id)
    loop
        begin
            starts_at := (entry.plan_date + coalesce(entry.start_time,time '09:00')) at time zone entry.timezone;
        exception when invalid_parameter_value then
            continue;
        end;
        for chosen in
            select 'default'::text as code,entry.default_minutes_before::integer as offset_minutes
            union all
            select ('extra:' || rule.minutes_before)::text,rule.minutes_before
                from public.at_plan_reminder_rules rule
                where rule.user_id=entry.user_id and rule.plan_id=entry.plan_id
                  and rule.minutes_before<>entry.default_minutes_before
        loop
            due_at := starts_at - pg_catalog.make_interval(mins=>chosen.offset_minutes);
            if due_at between clock_timestamp()-interval '2 minutes' and clock_timestamp() then
                insert into public.at_plan_reminder_jobs(user_id,plan_id,rule_code,minutes_before,due_at)
                    values(entry.user_id,entry.plan_id,chosen.code,chosen.offset_minutes,due_at)
                    on conflict do nothing;
                get diagnostics added=row_count;
                total:=total+added;
            end if;
        end loop;
    end loop;
    return total;
end;
$$;
revoke all on function public.at_enqueue_due_plan_reminders() from public,anon,authenticated;
grant execute on function public.at_enqueue_due_plan_reminders() to service_role;

create or replace function public.at_claim_due_plan_reminder_jobs(p_limit integer default 50)
returns setof public.at_plan_reminder_jobs
language plpgsql security definer set search_path = ''
as $$
begin
    return query
    with to_claim as (
        select id from public.at_plan_reminder_jobs
        where due_at between clock_timestamp()-interval '20 minutes' and clock_timestamp()
          and attempts<3
          and (state='pending' or (state='processing' and claimed_at<clock_timestamp()-interval '2 minutes'))
        order by due_at,id limit least(greatest(p_limit,1),100)
        for update skip locked
    )
    update public.at_plan_reminder_jobs j
    set state='processing',claimed_at=clock_timestamp(),attempts=attempts+1
    from to_claim where j.id=to_claim.id returning j.*;
end;
$$;
revoke all on function public.at_claim_due_plan_reminder_jobs(integer) from public,anon,authenticated;
grant execute on function public.at_claim_due_plan_reminder_jobs(integer) to service_role;

do $$
begin
    if exists(select 1 from pg_catalog.pg_extension where extname='pg_cron') and
       not exists(select 1 from cron.job where jobname='at-queue-plan-reminders') then
        perform cron.schedule('at-queue-plan-reminders','* * * * *',
            'select public.at_enqueue_due_plan_reminders()');
    end if;
end;
$$;
