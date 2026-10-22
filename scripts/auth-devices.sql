-- Server-only tables: custom AT authentication does not use auth.uid().
create table if not exists public.at_qr_logins (
    id uuid primary key default gen_random_uuid(),
    claim_hash text not null unique,
    browser_hash text not null,
    user_id uuid references public.users(id) on delete cascade,
    label text not null,
    code text not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);
create index if not exists at_qr_logins_expires on public.at_qr_logins(expires_at);
create index if not exists at_qr_logins_user on public.at_qr_logins(user_id);
alter table public.at_qr_logins enable row level security;
revoke all on public.at_qr_logins from public, anon, authenticated;
grant select, insert, update, delete on public.at_qr_logins to service_role;

create table if not exists public.at_trusted_devices (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    token_hash text not null unique,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);
create index if not exists at_trusted_devices_user on public.at_trusted_devices(user_id);
create index if not exists at_trusted_devices_expires on public.at_trusted_devices(expires_at);
alter table public.at_trusted_devices enable row level security;
revoke all on public.at_trusted_devices from public, anon, authenticated;
grant select, insert, update, delete on public.at_trusted_devices to service_role;
