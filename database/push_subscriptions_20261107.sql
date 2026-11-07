-- Stored subscriptions are available to the trusted backend only, never the public Data API.
create table if not exists public.at_push_subscriptions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    session_id uuid not null references public.at_user_sessions(id) on delete cascade,
    endpoint text not null,
    endpoint_hash text not null unique check (length(endpoint_hash) = 64),
    p256dh text not null,
    auth text not null,
    expiration_time bigint,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists at_push_subscriptions_user_idx on public.at_push_subscriptions(user_id);
alter table public.at_push_subscriptions enable row level security;
revoke all on public.at_push_subscriptions from anon, authenticated;
