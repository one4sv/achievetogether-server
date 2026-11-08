-- Applied to the AchieveTogether Supabase project on 2026-11-08.
-- These internal chat helpers are not public Data API endpoints.
-- The trigger function remains available to its trigger and to service_role.
revoke execute on function public.cleanup_hidden_messages()
    from public, anon, authenticated;
alter function public.cleanup_hidden_messages()
    set search_path = public, pg_temp;

revoke execute on function public.get_shared_chat(uuid, uuid)
    from public, anon, authenticated;
alter function public.get_shared_chat(uuid, uuid)
    set search_path = public, pg_temp;
