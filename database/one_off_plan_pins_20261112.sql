-- A plan's pinned state belongs to each accepted member, not the shared plan.
alter table public.one_off_plan_members
    add column if not exists pinned boolean not null default false;
