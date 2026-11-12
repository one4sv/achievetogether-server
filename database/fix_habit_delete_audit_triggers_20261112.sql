-- Keep single-completion and single-member audit records, but do not
-- recreate audit rows while the parent habit is being cascade-deleted.
-- This fixes SQLSTATE 23503 on DELETE /habits/:id (POST /delete goal=habit).

CREATE OR REPLACE FUNCTION public.audit_habit_changes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
    IF tg_table_name = 'habit_completions' AND tg_op = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM public.habits WHERE id = old.habit_id) THEN
            INSERT INTO public.habit_activity_events(habit_id, user_id, type, details)
            VALUES (old.habit_id, old.user_id, 'completion_removed',
                jsonb_build_object('date', old.completed_at));
        END IF;
        RETURN old;
    END IF;

    IF tg_table_name = 'habits' AND tg_op = 'UPDATE' THEN
        IF row(to_jsonb(new)->'metric_progress_mode', to_jsonb(new)->'schedule_blocks_mode',
               to_jsonb(new)->'members_can_edit_blocks', to_jsonb(new)->'members_can_edit_info',
               to_jsonb(new)->'members_can_invite', to_jsonb(new)->'chat_participation_mode')
           IS DISTINCT FROM
           row(to_jsonb(old)->'metric_progress_mode', to_jsonb(old)->'schedule_blocks_mode',
               to_jsonb(old)->'members_can_edit_blocks', to_jsonb(old)->'members_can_edit_info',
               to_jsonb(old)->'members_can_invite', to_jsonb(old)->'chat_participation_mode') THEN
            INSERT INTO public.habit_activity_events(habit_id, user_id, type, details)
            VALUES (new.id, new.user_id, 'settings_changed',
                jsonb_build_object(
                    'old', jsonb_build_object(
                        'metric_progress_mode', old.metric_progress_mode,
                        'schedule_blocks_mode', old.schedule_blocks_mode,
                        'members_can_edit_blocks', old.members_can_edit_blocks,
                        'members_can_edit_info', old.members_can_edit_info,
                        'members_can_invite', old.members_can_invite,
                        'chat_participation_mode', old.chat_participation_mode
                    ),
                    'new', jsonb_build_object(
                        'metric_progress_mode', new.metric_progress_mode,
                        'schedule_blocks_mode', new.schedule_blocks_mode,
                        'members_can_edit_blocks', new.members_can_edit_blocks,
                        'members_can_edit_info', new.members_can_edit_info,
                        'members_can_invite', new.members_can_invite,
                        'chat_participation_mode', new.chat_participation_mode
                    )
                ));
        END IF;
    END IF;
    RETURN new;
END
$function$;

CREATE OR REPLACE FUNCTION public.audit_habit_membership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
    IF tg_op = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM public.habits WHERE id = old.habit_id) THEN
            INSERT INTO public.habit_activity_events(habit_id, user_id, type)
            VALUES (old.habit_id, old.user_id, 'left');
        END IF;
        RETURN old;
    END IF;

    IF tg_op = 'INSERT' THEN
        INSERT INTO public.habit_activity_events(habit_id, user_id, type)
        VALUES (new.habit_id, new.user_id,
            CASE WHEN new.status = 'accepted' THEN 'joined' ELSE 'invited' END);
    ELSIF old.status IS DISTINCT FROM new.status THEN
        INSERT INTO public.habit_activity_events(habit_id, user_id, type)
        VALUES (new.habit_id, new.user_id,
            CASE new.status
                WHEN 'accepted' THEN 'joined'
                WHEN 'declined' THEN 'declined'
                ELSE 'invited'
            END);
    END IF;
    RETURN new;
END
$function$;
