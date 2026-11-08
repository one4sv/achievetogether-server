-- Applied to Supabase AchieveTogether 2026-11-08.
-- Backend-only feedback delivery queue; no client role access.
create table if not exists public.at_feedback_outbox (
    id text primary key check (id ~ '^[A-F0-9]{8}$'),
    user_id uuid references public.users(id) on delete set null,
    recipient text not null,
    subject text not null,
    html text not null,
    status text not null default 'pending'
        check (status in ('pending','processing','sent','failed')),
    attempts integer not null default 0 check (attempts between 0 and 10),
    next_attempt_at timestamptz not null default now(),
    claimed_at timestamptz,
    delivered_at timestamptz,
    last_error_code text,
    created_at timestamptz not null default now()
);
create index if not exists at_feedback_outbox_pending_idx
    on public.at_feedback_outbox(next_attempt_at)
    where status in ('pending','processing');
alter table public.at_feedback_outbox enable row level security;
revoke all on public.at_feedback_outbox from public,anon,authenticated;
grant all on public.at_feedback_outbox to service_role;
create or replace function public.at_claim_feedback_outbox(p_limit integer default 10)
returns setof public.at_feedback_outbox
language sql security definer set search_path = public, pg_temp
as $$
    with to_claim as (
        select id from public.at_feedback_outbox
        where (status='pending' and next_attempt_at <= clock_timestamp())
           or (status='processing' and claimed_at < clock_timestamp() - interval '5 minutes')
        order by created_at,id limit least(greatest(p_limit,1),20)
        for update skip locked
    )
    update public.at_feedback_outbox o
    set status='processing',attempts=o.attempts+1,claimed_at=clock_timestamp()
    from to_claim where o.id=to_claim.id returning o.*;
$$;
revoke all on function public.at_claim_feedback_outbox(integer) from public,anon,authenticated;
grant execute on function public.at_claim_feedback_outbox(integer) to service_role;