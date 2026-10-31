import { broadcastGroupUpdated, broadcastNewMessage } from "../realtime/ws.js";

export const validUserIds = value => Array.isArray(value) && value.length > 0 && value.length <= 100 &&
    value.every(id => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));

export async function publishInvitationMessages(supabase, ids = []) {
    if (!ids.length) return;
    try {
        const { data, error } = await supabase.from("messages").select("*").in("id", ids);
        if (error) throw error;
        for (const message of data || []) {
            await broadcastNewMessage(message.chat_id, { ...message, files: [], reactions: message.reactions || [], read_by: message.read_by || [] });
        }
    } catch (error) {
        // The transaction is already committed. A realtime failure must not invite twice.
        console.error("[group invitations] realtime update failed", error);
    }
}

export async function inviteGroupUsers(supabase, actorId, groupId, members) {
    if (!validUserIds(members)) throw Object.assign(new Error("Некорректный список участников"), { code: "22023" });
    const { data, error } = await supabase.rpc("deliver_group_invitations", {
        p_actor: actorId,
        p_chat: groupId,
        p_targets: [...new Set(members)],
        p_client_url: process.env.CLIENT_URL || "https://achievetogether.vercel.app",
    });
    if (error) throw error;
    await publishInvitationMessages(supabase, data.message_ids);
    try {
        await broadcastGroupUpdated(groupId);
    } catch (error) {
        console.error("[group invitations] group update failed", error);
    }
    const { message_ids, ...result } = data;
    return result;
}

export async function joinRequiredChatActivities(supabase, chatId, userId) {
    const { data: activities, error: activitiesError } = await supabase.from("habits")
        .select("id, user_id").eq("chat_id", chatId).eq("ongoing", true)
        .eq("chat_participation_mode", "required");
    if (activitiesError) throw activitiesError;
    const targets = (activities || []).filter(item => item.user_id !== userId);
    if (!targets.length) return;
    const { data: memberships, error: membersError } = await supabase.from("habit_members")
        .select("habit_id, status").eq("user_id", userId).in("habit_id", targets.map(item => item.id));
    if (membersError) throw membersError;
    const accepted = new Set((memberships || []).filter(m => m.status === "accepted").map(m => m.habit_id));
    const rows = targets.filter(item => !accepted.has(item.id))
        .map(item => ({ habit_id: item.id, user_id: userId, invited_by: item.user_id,
            status: "accepted", updated_at: new Date().toISOString() }));
    if (!rows.length) return;
    const { error } = await supabase.from("habit_members").upsert(rows, { onConflict: "habit_id,user_id" });
    if (error) throw error;
}

export function invitationError(res, error) {
    const status = error.code === "42501" ? 403 : error.code === "22023" ? 400 : 500;
    console.error("[group invitations]", error);
    return res.status(status).json({ success: false, error: status === 500 ? "Не удалось обработать приглашение" : "Приглашение недоступно или запрещено настройками конфиденциальности" });
}

export async function personalInvitation(supabase, req, res, respond = false) {
    if (!req.user?.id) return res.status(401).json({ success: false, error: "Войдите в аккаунт получателя приглашения" });
    const token = respond ? req.body.token : req.params.token;
    const id = token.slice(2);
    if (!validUserIds([id])) return res.status(404).json({ success: false, error: "Приглашение не найдено" });
    try {
        if (respond) {
            const { data, error } = await supabase.rpc("respond_group_invitation", {
                p_actor: req.user.id, p_invitation: id, p_accept: req.body.decline !== true,
            });
            if (error) throw error;
            if (data.message_id) await publishInvitationMessages(supabase, [data.message_id]);
            if (data.chat_id) {
                if (req.body.decline !== true) {
                    try { await joinRequiredChatActivities(supabase, data.chat_id, req.user.id); }
                    catch (joinError) { console.error("[group invitations] activity sync failed", joinError); }
                }
                try {
                    await broadcastGroupUpdated(data.chat_id);
                } catch (error) {
                    console.error("[group invitations] group update failed", error);
                }
            }
            return res.json({ success: true, ...data });
        }
        const { data: invite, error } = await supabase.from("group_invitations")
            .select("chat_id, status, expires_at").eq("id", id).eq("recipient_id", req.user.id).maybeSingle();
        if (error) throw error;
        if (!invite || invite.status !== "pending" || new Date(invite.expires_at) <= new Date()) {
            return res.status(404).json({ success: false, error: "Приглашение недоступно" });
        }
        const { data: group, error: groupError } = await supabase.from("chats").select("id, name, desc, avatar_url").eq("id", invite.chat_id).single();
        if (groupError) throw groupError;
        const { count, error: countError } = await supabase.from("chat_members").select("id", { count: "exact", head: true }).eq("chat_id", invite.chat_id);
        if (countError) throw countError;
        const { data: activities, error: activityError } = await supabase.from("habits")
            .select("id, name, chat_participation_mode").eq("chat_id", invite.chat_id).eq("ongoing", true);
        if (activityError) throw activityError;
        return res.json({ success: true, personal: true, group: { ...group, member_count: count || 0 }, activities: activities || [] });
    } catch (error) {
        return invitationError(res, error);
    }
}
