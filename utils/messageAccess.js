// Server-side access for message mutations; UI permissions are not authorization.
export async function canAccessMessage(supabase, message, userId) {
    if (!userId || !message || message.hidden?.includes(userId)) return false;
    const { data: member, error } = await supabase.from("chat_members")
        .select("user_id,is_blocked").eq("chat_id", message.chat_id)
        .eq("user_id", userId).maybeSingle();
    if (error) throw error;
    return !!member && !member.is_blocked;
}
