-- Settings security and scheduled account-removal metadata.
-- Existing accounts remain unchanged; no user data is deleted by this migration.
alter table public.users add column if not exists deletion_requested_at timestamptz;
alter table public.users add column if not exists deletion_delete_messages boolean not null default false;

create table if not exists public.at_account_actions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    action text not null check (action in ('delete', 'recover', 'email_change')),
    target_email text,
    code_hash text not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    consumed_at timestamptz,
    attempts integer not null default 0 check (attempts between 0 and 100)
);
create index if not exists at_account_actions_lookup_idx
    on public.at_account_actions(user_id, action, expires_at desc);
alter table public.at_account_actions enable row level security;
revoke all on public.at_account_actions from anon, authenticated;
grant all on public.at_account_actions to service_role;

create table if not exists public.at_2fa_recovery_codes (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    code_hash text not null,
    used_at timestamptz,
    created_at timestamptz not null default now(),
    unique (user_id, code_hash)
);
create index if not exists at_2fa_recovery_codes_lookup_idx
    on public.at_2fa_recovery_codes(user_id, used_at);
alter table public.at_2fa_recovery_codes enable row level security;
revoke all on public.at_2fa_recovery_codes from anon, authenticated;
grant all on public.at_2fa_recovery_codes to service_role;

-- Keep other participants' history when an account is erased with
-- "delete my messages" disabled. The sender column already permits NULL.
alter table public.messages drop constraint if exists messages_sender_id_fkey;
alter table public.messages add constraint messages_sender_id_fkey
    foreign key (sender_id) references public.users(id) on delete set null;

create index if not exists users_pending_deletion_idx
    on public.users(deletion_requested_at) where deletion_requested_at is not null;
