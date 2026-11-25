alter table public.posts add column if not exists goal_id bigint references public.at_goals(id) on delete set null;
alter table public.posts add column if not exists plan_id bigint references public.one_off_plans(id) on delete set null;
create index if not exists posts_goal_id_idx on public.posts(goal_id) where goal_id is not null;
create index if not exists posts_plan_id_idx on public.posts(plan_id) where plan_id is not null;