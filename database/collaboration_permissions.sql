alter table public.habits
    add column complete_permission text not null default 'members' check (complete_permission in ('owner','members','roles')),
    add column comment_permission text not null default 'members' check (comment_permission in ('owner','members','roles')),
    add column edit_blocks_permission text check (edit_blocks_permission in ('owner','members','roles')),
    add column edit_info_permission text check (edit_info_permission in ('owner','members','roles')),
    add column invite_permission text check (invite_permission in ('owner','members','roles'));

create function public.habit_has_permission(p_actor uuid,p_habit bigint,p_action text)
returns boolean language plpgsql stable security invoker set search_path = '' as $$
declare h public.habits%rowtype; policy text; m public.chat_members%rowtype; role_permissions jsonb; creator uuid;
begin
    if p_actor is null or p_action not in ('complete','comment','edit_blocks','edit_info','invite') then return false; end if;
    select * into h from public.habits where id=p_habit;
    if not found then return false; end if;
    if h.user_id=p_actor then return true; end if;
    if not exists(select 1 from public.habit_members where habit_id=p_habit and user_id=p_actor and status='accepted') then return false; end if;
    if h.chat_id is not null then
        select * into m from public.chat_members where chat_id=h.chat_id and user_id=p_actor;
        if m.is_blocked then return false; end if;
    end if;
    policy := coalesce(to_jsonb(h)->>(p_action||'_permission'),case
        when p_action='edit_blocks' and h.members_can_edit_blocks then 'members'
        when p_action='edit_info' and h.members_can_edit_info then 'members'
        when p_action='invite' and h.members_can_invite then 'members'
        else 'owner' end);
    if policy='members' then return true; end if;
    if policy<>'roles' or h.chat_id is null or m.id is null then return false; end if;
    select creator_id into creator from public.chats where id=h.chat_id and is_group;
    if creator=p_actor then return true; end if;
    select permissions into role_permissions from public.chat_roles where id=m.role_id and chat_id=h.chat_id;
    return coalesce(m.permission_overrides->('habit_'||p_action),role_permissions->('habit_'||p_action),'false'::jsonb)='true'::jsonb;
end;
$$;

create function public.habit_permissions(p_actor uuid,p_habit bigint)
returns jsonb language sql stable security invoker set search_path = '' as $$
    select jsonb_build_object(
        'is_owner',h.user_id=p_actor,
        'is_member',h.user_id=p_actor or exists(select 1 from public.habit_members where habit_id=h.id and user_id=p_actor and status='accepted'),
        'can_complete',h.ongoing and public.habit_has_permission(p_actor,h.id,'complete'),
        'can_comment',h.ongoing and public.habit_has_permission(p_actor,h.id,'comment'),
        'can_edit_blocks',h.ongoing and public.habit_has_permission(p_actor,h.id,'edit_blocks'),
        'can_edit_info',h.ongoing and public.habit_has_permission(p_actor,h.id,'edit_info'),
        'can_invite',h.ongoing and public.habit_has_permission(p_actor,h.id,'invite')
    ) from public.habits h where h.id=p_habit;
$$;
revoke all on function public.habit_has_permission(uuid,bigint,text),public.habit_permissions(uuid,bigint) from public,anon,authenticated;
grant execute on function public.habit_has_permission(uuid,bigint,text),public.habit_permissions(uuid,bigint) to service_role;

create function public.save_habit_day_comment(p_actor uuid,p_habit bigint,p_date date,p_text text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
    perform 1 from public.habits where id=p_habit for update;
    if not public.habit_has_permission(p_actor,p_habit,'comment') then
        raise exception 'Comment permission denied' using errcode='42501';
    end if;
    if p_text is null or char_length(p_text)>200 or p_date is null then
        raise exception 'Invalid comment' using errcode='22023';
    end if;
    if exists(select 1 from public.completions_comments where habit_id=p_habit and user_id=p_actor and date=p_date) then
        update public.completions_comments set comment=p_text where habit_id=p_habit and user_id=p_actor and date=p_date;
    else
        insert into public.completions_comments(habit_id,user_id,comment,date) values(p_habit,p_actor,p_text,p_date);
    end if;
end;
$$;
revoke all on function public.save_habit_day_comment(uuid,bigint,date,text) from public,anon,authenticated;
grant execute on function public.save_habit_day_comment(uuid,bigint,date,text) to service_role;

