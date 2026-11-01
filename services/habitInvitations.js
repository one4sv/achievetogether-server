import { broadcastNewMessage, broadcastMessageEdited } from "../realtime/ws.js";

export function sendInvitationError(res, error) {
    const status = error.code === "42501" ? 403 : error.code === "22023" ? 409 : 500;
    console.error("[habit invitation]", error);
    return res.status(status).json({
        success: false,
        error: status === 403 ? "Приглашение запрещено или недоступно" : status === 409 ? "Приглашение уже обработано или недоступно" : "Не удалось обработать приглашение"
    });
}

export async function publishHabitInvitation(supabase, messageId, edited = false) {
    try {
        const { data: message, error } = await supabase.from("messages").select("*").eq("id", messageId).single();
        if (error) throw error;
        const { data: sender, error: senderError } = await supabase.from("users")
            .select("nick, username, avatar_url").eq("id", message.sender_id).single();
        if (senderError) throw senderError;
        const payload = {
            ...message,
            sender_name: sender.username || sender.nick,
            sender_nick: sender.nick,
            sender_avatar_url: sender.avatar_url,
            files: [],
            read_by: message.read_by || [],
            reactions: message.reactions || []
        };
        if (edited) broadcastMessageEdited(message.chat_id, payload, "HABIT_INVITATION_UPDATED");
        else await broadcastNewMessage(message.chat_id, payload);
    } catch (error) {
        // Membership and message are already committed; realtime cannot undo delivery.
        console.error("[habit invitation] realtime delivery failed", error);
    }
}

export async function readHabitInvitation(supabase, messageId, userId) {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return null;
    const { data: message, error } = await supabase.from("messages")
        .select("id, chat_id, sender_id, habit_invite_habit_id, habit_invite_recipient_id, hidden")
        .eq("id", messageId).maybeSingle();
    if (error) throw error;
    if (!message?.habit_invite_habit_id || !message.habit_invite_recipient_id || message.hidden?.includes(userId)) return null;
    if (message.sender_id !== userId && message.habit_invite_recipient_id !== userId) return null;
    const { data: inChat, error: chatError } = await supabase.from("chat_members")
        .select("id").eq("chat_id", message.chat_id).eq("user_id", userId).maybeSingle();
    if (chatError) throw chatError;
    if (!inChat) return null;
    const { data: habit, error: habitError } = await supabase.from("habits")
        .select("id, name, tag, start_time, end_time, periodicity, ongoing")
        .eq("id", message.habit_invite_habit_id).maybeSingle();
    if (habitError) throw habitError;
    if (!habit) return null;
    const { data: member, error: memberError } = await supabase.from("habit_members")
        .select("status, invitation_message_id").eq("habit_id", habit.id)
        .eq("user_id", message.habit_invite_recipient_id).maybeSingle();
    if (memberError) throw memberError;
    const status = member?.invitation_message_id === messageId ? member.status : "cancelled";
    return { habit, status, can_respond: userId === message.habit_invite_recipient_id && status === "pending" };
}
