-- Applied to Supabase AchieveTogether 2026-11-08.
-- Pin search_path on existing database helper/trigger functions to avoid
-- resolving user-writable schema objects through an implicit search path.
alter function public.update_done_id_in_timers()
    set search_path = public, pg_temp;
alter function public.update_comments_count()
    set search_path = public, pg_temp;
alter function public.update_edited_at()
    set search_path = public, pg_temp;
alter function public.at_reminder_active_day(public.habits, date)
    set search_path = public, pg_temp;
alter function public.auto_end_timers()
    set search_path = public, pg_temp;
