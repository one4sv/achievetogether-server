-- Stable linked reference, with server-side ACL checks on creation and rendering.
alter table public.messages add column if not exists entity_type text;
alter table public.messages add column if not exists entity_id text;
