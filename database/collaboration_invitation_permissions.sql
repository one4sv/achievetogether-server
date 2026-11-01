create or replace function public.send_habit_invitation(p_actor uuid, p_habit bigint, p_target uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
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
$$;


create or replace function public.respond_habit_invitation(p_actor uuid,p_habit bigint,p_status text,p_message bigint default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_member public.habit_members%rowtype; v_message public.messages%rowtype; v_habit public.habits%rowtype;
begin
    if p_actor is null or p_status not in ('accepted','declined') or p_status is null then
        raise exception 'Invalid response' using errcode = '22023';
    end if;
    select * into v_habit from public.habits where id = p_habit for update;
    if not found then raise exception 'Activity not found' using errcode = '22023'; end if;
    select * into v_member from public.habit_members where habit_id = p_habit and user_id = p_actor for update;
    if not found or (p_message is not null and p_message is distinct from v_member.invitation_message_id) then
        raise exception 'Invitation not found' using errcode = '42501';
    end if;
    if v_member.status <> 'pending' and v_member.status <> p_status then
        raise exception 'Invitation already answered' using errcode = '22023';
    end if;
    if p_status = 'accepted' and v_member.status = 'pending' and not public.habit_has_permission(v_member.invited_by,p_habit,'invite') then raise exception 'Inviter no longer has permission' using errcode = '42501'; end if;
    if v_member.status = 'pending' then
        update public.habit_members set status = p_status, updated_at = now() where habit_id = p_habit and user_id = p_actor;
    end if;
    select * into v_message from public.messages where id = v_member.invitation_message_id;
    return jsonb_build_object('status',p_status,'message_id',v_message.id,'chat_id',v_message.chat_id);
end;
$$;

CREATE OR REPLACE FUNCTION public.change_habit_counter(p_habit_id bigint, p_actor uuid, p_delta numeric, p_reset boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare h public.habits%rowtype; c public.habit_counters%rowtype; v_user uuid; v_min numeric; v_old numeric; v_new numeric; v_day date; v_stamp timestamptz;
begin
 if not public.habit_has_permission(p_actor,p_habit_id,'complete') then raise exception 'Completion permission denied' using errcode='42501'; end if;
 if p_actor is null or p_habit_id is null or (not p_reset and (p_delta is null or p_delta=0 or abs(p_delta)>1000000000)) then
   raise exception 'Invalid input' using errcode='22023';
 end if;
 select * into h from public.habits where id=p_habit_id;
 if not found then raise exception 'Activity not found' using errcode='22023'; end if;
 if h.user_id<>p_actor and not exists(select 1 from public.habit_members where habit_id=p_habit_id and user_id=p_actor and status='accepted') then
   raise exception 'Access denied' using errcode='42501';
 end if;
 v_user:=case when h.metric_progress_mode='shared' then h.user_id else p_actor end;
 perform pg_advisory_xact_lock(hashtextextended(p_habit_id::text || ':' || v_user::text,0));
 v_day := (now() at time zone 'Europe/Moscow')::date;
 select * into c from public.habit_counters where habit_id=p_habit_id and user_id=v_user and (created_at at time zone 'Europe/Moscow')::date=v_day order by created_at desc limit 1 for update;
 if not found then
   select coalesce(min_counter,0) into v_min from public.counter_settings where habit_id=p_habit_id;
   v_min:=coalesce(v_min,0);
   insert into public.habit_counters(habit_id,user_id,count,progression,min_count)
     values(p_habit_id,v_user,0,array[]::jsonb[],v_min) returning * into c;
 end if;
 v_old:=coalesce(c.count,0);
 v_new:=case when p_reset then 0 else greatest(0,v_old+p_delta) end;
 v_stamp:=clock_timestamp();
 if v_new<>v_old then
  update public.habit_counters set count=v_new,progression=coalesce(c.progression,array[]::jsonb[]) || array[jsonb_build_object('count',v_new-v_old,'time',v_stamp,'text','','actor_id',p_actor)]::jsonb[]
  where id=c.id;
 end if;
 if v_old<coalesce(c.min_count,0) and v_new>=coalesce(c.min_count,0) then
   if not exists(select 1 from public.habit_completions where habit_id=p_habit_id and user_id=v_user and completed_at=v_day) then
     insert into public.habit_completions(habit_id,user_id,completed_at,is_user_marked) values(p_habit_id,v_user,v_day,false);
   end if;
 elsif v_old>=coalesce(c.min_count,0) and v_new<coalesce(c.min_count,0) then
   delete from public.habit_completions where habit_id=p_habit_id and user_id=v_user and completed_at=v_day and is_user_marked is not true;
 end if;
 return jsonb_build_object('count',v_new,'counter_id',c.id,'user_id',v_user);
end; $function$

