-- Applied in Supabase: habit_completion_actor_for_day_activity_20261102
alter table public.habit_completions
    add column if not exists actor_user_id uuid;
comment on column public.habit_completions.actor_user_id
    is 'User who manually toggled completion. For shared progress the progress owner is kept in user_id; actor_user_id identifies the actual participant.';
