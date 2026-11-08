-- These notification toggles were used by the API but missing in production.
alter table public.settings
    add column if not exists all_note boolean not null default true;
alter table public.settings
    add column if not exists new_mess_note boolean not null default true;
