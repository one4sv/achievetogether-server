-- Optional activity-compatible tag for one-off plans.
-- Existing plans keep NULL; no RLS or access policy changes.
alter table public.one_off_plans
    add column if not exists tag text null;
alter table public.one_off_plans
    drop constraint if exists one_off_plans_tag_length;
alter table public.one_off_plans
    add constraint one_off_plans_tag_length
    check (tag is null or char_length(tag) <= 32);
