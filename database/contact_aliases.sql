create table public.contact_aliases (
    owner_id uuid not null references public.users(id) on delete cascade,
    contact_id uuid not null references public.users(id) on delete cascade,
    alias text not null check (char_length(alias) <= 40 and alias = btrim(alias)),
    primary key (owner_id, contact_id),
    check (owner_id <> contact_id)
);
alter table public.contact_aliases enable row level security;
revoke all on public.contact_aliases from public, anon, authenticated;
grant select, insert, update, delete on public.contact_aliases to service_role;
create index contact_aliases_contact_idx on public.contact_aliases(contact_id);
