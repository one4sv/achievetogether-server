-- Keep SQL membership flags aligned with the blocked-chat protection in getHabitAccess.
-- Applied to Supabase as habit_permissions_exclude_blocked_members_20261102.
create or replace function public.habit_permissions(p_actor uuid, p_habit bigint)
returns jsonb
language sql
stable
security invoker
set search_path to ''
as $$
    select jsonb_build_object(
        'is_owner', h.user_id = p_actor,
        'is_member', h.user_id = p_actor or (
            exists (
                select 1 from public.habit_members hm
                where hm.habit_id = h.id and hm.user_id = p_actor and hm.status = 'accepted'
            )
            and not exists (
                select 1 from public.chat_members cm
                where cm.chat_id = h.chat_id and cm.user_id = p_actor and cm.is_blocked is true
            )
        ),
        'can_complete', h.ongoing and public.habit_has_permission(p_actor,h.id,'complete'),
        'can_comment', h.ongoing and public.habit_has_permission(p_actor,h.id,'comment'),
        'can_edit_blocks', h.ongoing and public.habit_has_permission(p_actor,h.id,'edit_blocks'),
        'can_edit_info', h.ongoing and public.habit_has_permission(p_actor,h.id,'edit_info'),
        'can_invite', h.ongoing and public.habit_has_permission(p_actor,h.id,'invite')
    ) from public.habits h where h.id=p_habit;
$$;
