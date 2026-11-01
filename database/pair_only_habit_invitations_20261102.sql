-- Applied in Supabase: enforce_pair_only_habit_invitations_20261102.
-- A personal activity allows at most one other accepted/pending participant.
-- Group-bound activities must invite new people through their chat.
CREATE OR REPLACE FUNCTION public.send_habit_invitation(p_actor uuid, p_habit bigint, p_target uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
    v_habit public.habits%rowtype;
    v_member public.habit_members%rowtype;
    v_privacy jsonb;
    v_exception text;
    v_contact boolean;
    v_chat bigint;
    v_message bigint;
begin
    if p_actor is null or p_target is null then
        raise exception 'Invalid recipient' using errcode = '22023';
    end if;
    select * into v_habit from public.habits where id = p_habit for update;
    if not found then raise exception 'Activity not found' using errcode = '22023'; end if;
    if not public.habit_has_permission(p_actor,p_habit,'invite') then raise exception 'Invitation permission denied' using errcode = '42501'; end if;
    if p_target = v_habit.user_id or p_target = p_actor or not exists(select 1 from public.users where id = p_target) then
        raise exception 'Invalid recipient' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(least(p_actor::text,p_target::text)||':'||greatest(p_actor::text,p_target::text),0));
    if exists (
        select 1 from public.chat_members a
        join public.chat_members b on b.chat_id = a.chat_id and b.user_id = p_target
        join public.chats c on c.id = a.chat_id and not c.is_group
        where a.user_id = p_actor and (a.is_blocked or b.is_blocked)
    ) then raise exception 'User blocked' using errcode = '42501'; end if;
    select s.private into v_privacy from public.settings s where s.user_id = p_target for share;
    v_exception := v_privacy->'activity_invite_exceptions'->>p_actor::text;
    select exists (
        select 1 from public.chat_members a
        join public.chat_members b on b.chat_id = a.chat_id and b.user_id = p_target
        join public.chats c on c.id = a.chat_id and not c.is_group
        where a.user_id = p_actor and exists (
            select 1 from public.messages m where m.chat_id = c.id and m.sender_id = p_target and not m.is_system
        )
    ) into v_contact;
    if v_exception = 'deny' or (coalesce(v_exception,'') <> 'allow' and (
        v_privacy->>'activity_invites' = 'nobody' or (v_privacy->>'activity_invites' = 'contacts' and not v_contact)
    )) then raise exception 'Recipient privacy denied' using errcode = '42501'; end if;
    if v_habit.chat_id is not null then
        raise exception 'Invite through linked chat' using errcode = '22023';
    end if;
    if exists (
        select 1 from public.habit_members hm
        where hm.habit_id = p_habit and hm.user_id <> p_target
          and hm.status in ('accepted','pending')
    ) then
        raise exception 'Pair is full; create or link a group chat' using errcode = '22023';
    end if;
    select * into v_member from public.habit_members where habit_id = p_habit and user_id = p_target for update;
    if v_member.status = 'accepted' then return jsonb_build_object('already_member',true); end if;
    if v_member.status = 'pending' and v_member.invitation_message_id is not null then
        return jsonb_build_object('already_invited',true,'message_id',v_member.invitation_message_id);
    end if;
    select c.id into v_chat from public.chats c
    join public.chat_members a on a.chat_id = c.id and a.user_id = p_actor
    join public.chat_members b on b.chat_id = c.id and b.user_id = p_target
    where not c.is_group order by c.id limit 1;
    if v_chat is null then
        insert into public.chats(is_group) values(false) returning id into v_chat;
        insert into public.chat_members(chat_id,user_id) values(v_chat,p_actor),(v_chat,p_target);
    end if;
    insert into public.messages(chat_id,sender_id,content,habit_invite_habit_id,habit_invite_recipient_id)
    values(v_chat,p_actor,'Приглашение в активность «'||v_habit.name||'»',p_habit,p_target) returning id into v_message;
    insert into public.habit_members(habit_id,user_id,invited_by,status,invitation_message_id)
    values(p_habit,p_target,p_actor,'pending',v_message)
    on conflict(habit_id,user_id) do update set
        status = 'pending', invited_by = p_actor, invitation_message_id = v_message, updated_at = now();
    return jsonb_build_object('message_id',v_message,'chat_id',v_chat);
end;
$function$
;
