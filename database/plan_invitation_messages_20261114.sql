-- AT: one invitation workflow for plans and habits, delivered in personal chats.
-- Service-role-only RPCs keep membership and the message in one transaction.
alter table public.messages
    add column if not exists plan_invite_plan_id bigint references public.one_off_plans(id) on delete set null,
    add column if not exists plan_invite_recipient_id uuid references public.users(id) on delete set null;

alter table public.one_off_plan_members
    add column if not exists invitation_message_id bigint references public.messages(id) on delete set null;

create index if not exists messages_plan_invite_plan_idx
    on public.messages(plan_invite_plan_id) where plan_invite_plan_id is not null;
create index if not exists messages_plan_invite_recipient_idx
    on public.messages(plan_invite_recipient_id) where plan_invite_recipient_id is not null;
create unique index if not exists plan_members_invitation_message_idx
    on public.one_off_plan_members(invitation_message_id) where invitation_message_id is not null;

create or replace function public.send_plan_invitation(p_actor uuid, p_plan bigint, p_target uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_plan public.one_off_plans%rowtype;
    v_member public.one_off_plan_members%rowtype;
    v_chat bigint;
    v_message bigint;
begin
    if p_actor is null or p_target is null or p_actor = p_target then
        raise exception 'Invalid recipient' using errcode = '22023';
    end if;
    select * into v_plan from public.one_off_plans where id = p_plan for update;
    if not found then raise exception 'Plan not found' using errcode = '22023'; end if;
    if v_plan.owner_id is distinct from p_actor then
        raise exception 'Only the owner may invite' using errcode = '42501';
    end if;
    if v_plan.status <> 'upcoming' or not exists (select 1 from public.users where id = p_target) then
        raise exception 'Plan cannot be invited to' using errcode = '22023';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(least(p_actor::text, p_target::text) || ':' ||
            greatest(p_actor::text, p_target::text), 0));
    if exists (
        select 1 from public.chat_members a
        join public.chat_members b on b.chat_id = a.chat_id and b.user_id = p_target
        join public.chats c on c.id = a.chat_id and not c.is_group
        where a.user_id = p_actor and (a.is_blocked or b.is_blocked)
    ) then raise exception 'User blocked' using errcode = '42501'; end if;

    select * into v_member from public.one_off_plan_members
        where plan_id = p_plan and user_id = p_target for update;
    if v_member.status = 'accepted' then return jsonb_build_object('already_member', true); end if;
    if v_member.status = 'pending' and v_member.invitation_message_id is not null then
        return jsonb_build_object('already_invited', true, 'message_id', v_member.invitation_message_id);
    end if;

    select c.id into v_chat from public.chats c
    join public.chat_members a on a.chat_id = c.id and a.user_id = p_actor
    join public.chat_members b on b.chat_id = c.id and b.user_id = p_target
    where not c.is_group order by c.id limit 1;
    if v_chat is null then
        insert into public.chats(is_group) values(false) returning id into v_chat;
        insert into public.chat_members(chat_id, user_id)
            values(v_chat, p_actor), (v_chat, p_target);
    end if;

    insert into public.messages(chat_id, sender_id, content, plan_invite_plan_id, plan_invite_recipient_id)
    values(v_chat, p_actor, 'Приглашение в план «' || v_plan.name || '»', p_plan, p_target)
    returning id into v_message;
    insert into public.one_off_plan_members(plan_id, user_id, invited_by, status, joined_at, invitation_message_id)
    values(p_plan, p_target, p_actor, 'pending', null, v_message)
    on conflict(plan_id, user_id) do update set
        status = 'pending', invited_by = p_actor, joined_at = null,
        invitation_message_id = v_message;
    if v_plan.kind = 'personal' then
        update public.one_off_plans set kind = 'shared', updated_at = now()
            where id = p_plan;
    end if;
    return jsonb_build_object('message_id', v_message, 'chat_id', v_chat);
end;
$$;

create or replace function public.respond_plan_invitation(
    p_actor uuid, p_plan bigint, p_status text, p_message bigint)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_plan public.one_off_plans%rowtype;
    v_member public.one_off_plan_members%rowtype;
    v_message public.messages%rowtype;
begin
    if p_actor is null or p_status not in ('accepted','declined') or p_message is null or p_message <= 0 then
        raise exception 'Invalid invitation response' using errcode = '22023';
    end if;
    select * into v_plan from public.one_off_plans where id = p_plan for update;
    if not found then raise exception 'Plan not found' using errcode = '22023'; end if;
    if v_plan.status = 'canceled' or v_plan.owner_id = p_actor then
        raise exception 'Plan invitation unavailable' using errcode = '42501';
    end if;
    select * into v_member from public.one_off_plan_members
        where plan_id = p_plan and user_id = p_actor for update;
    if not found or v_member.invitation_message_id is distinct from p_message then
        raise exception 'Invitation not found' using errcode = '42501';
    end if;
    select * into v_message from public.messages
        where id = p_message and plan_invite_plan_id = p_plan
            and plan_invite_recipient_id = p_actor;
    if not found then raise exception 'Invitation message unavailable' using errcode = '42501'; end if;
    if not exists (
        select 1 from public.chat_members where chat_id = v_message.chat_id
            and user_id = p_actor and is_blocked = false
    ) then raise exception 'Chat access revoked' using errcode = '42501'; end if;
    if v_member.status <> 'pending' then
        if v_member.status = p_status then
            return jsonb_build_object('status', p_status, 'message_id', p_message, 'chat_id', v_message.chat_id);
        end if;
        raise exception 'Invitation already answered' using errcode = '22023';
    end if;
    update public.one_off_plan_members set status = p_status,
        joined_at = case when p_status = 'accepted' then now() else null end
        where plan_id = p_plan and user_id = p_actor and status = 'pending';
    return jsonb_build_object('status', p_status, 'message_id', p_message, 'chat_id', v_message.chat_id);
end;
$$;

revoke all on function public.send_plan_invitation(uuid,bigint,uuid),
    public.respond_plan_invitation(uuid,bigint,text,bigint) from public, anon, authenticated;
grant execute on function public.send_plan_invitation(uuid,bigint,uuid),
    public.respond_plan_invitation(uuid,bigint,text,bigint) to service_role;
