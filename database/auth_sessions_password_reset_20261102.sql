-- AT custom JWT auth: server-side revocable sessions and single-use password reset links.
alter table public.users
    add column if not exists auth_version integer not null default 1;

create table if not exists public.at_user_sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    user_agent text not null default '',
    ip_address text,
    created_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    expires_at timestamptz not null,
    revoked_at timestamptz
);
create index if not exists at_user_sessions_active on public.at_user_sessions(user_id, expires_at)
    where revoked_at is null;

create table if not exists public.at_password_resets (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    token_hash text not null unique,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    used_at timestamptz
);
create index if not exists at_password_resets_user on public.at_password_resets(user_id, created_at);
create index if not exists at_password_resets_expiry on public.at_password_resets(expires_at);

alter table public.at_user_sessions enable row level security;
alter table public.at_password_resets enable row level security;
revoke all on public.at_user_sessions from PUBLIC, anon, authenticated;
revoke all on public.at_password_resets from PUBLIC, anon, authenticated;
grant select, insert, update, delete on public.at_user_sessions to service_role;
grant select, insert, update, delete on public.at_password_resets to service_role;
-- These tables are intentionally never directly accessible from the browser.
-- Tokens without both sid and v will be rejected after rollout: users sign in again once.

alter table public.at_trusted_devices
    add column if not exists session_id uuid references public.at_user_sessions(id) on delete set null,
    add column if not exists user_agent text not null default '',
    add column if not exists ip_address text,
    add column if not exists last_used_at timestamptz;
create index if not exists at_trusted_devices_session on public.at_trusted_devices(session_id);

create table if not exists public.at_ws_tickets (
    token_hash text primary key,
    user_id uuid not null references public.users(id) on delete cascade,
    session_id uuid references public.at_user_sessions(id) on delete cascade,
    auth_version integer not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);
create index if not exists at_ws_tickets_expires on public.at_ws_tickets(expires_at);
alter table public.at_ws_tickets enable row level security;
revoke all on public.at_ws_tickets from PUBLIC, anon, authenticated;
grant select, insert, update, delete on public.at_ws_tickets to service_role;
