-- Applied in Supabase as checklist_task_completion_author_20261102
alter table public.checklist_completions add column if not exists completed_by uuid;
alter table public.checklist_completions add column if not exists completed_at timestamptz;
