-- User-controlled mention notifications, separate from normal chat push.
alter table public.settings add column if not exists mentions_note boolean not null default true;
