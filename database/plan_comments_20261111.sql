-- Personal day-style comments for one-off plans, separate from plan description.
create table if not exists public.one_off_plan_comments (
    plan_id bigint not null references public.one_off_plans(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    comment text not null default '' check (char_length(comment) <= 200),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (plan_id, user_id)
);
create index if not exists one_off_plan_comments_plan on public.one_off_plan_comments(plan_id);
alter table public.one_off_plan_comments enable row level security;
revoke all on public.one_off_plan_comments from anon,authenticated;
grant select,insert,update,delete on public.one_off_plan_comments to service_role;
