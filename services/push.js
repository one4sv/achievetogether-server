import { sendWebPush, validPushEndpoint } from "../utils/webPush.js";

const safeBody = content => String(content || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);

export async function deliverMessagePush(supabase, { userId, senderId, senderName, senderNick, chatId, chatName, isGroup, message }) {
    if (!userId || userId === senderId) return;
    if (Array.isArray(message.hidden) && message.hidden.includes(userId)) return;
    const { data: subscriptions, error } = await supabase.from("at_push_subscriptions")
        .select("endpoint,endpoint_hash,p256dh,auth,expiration_time,session_id")
        .eq("user_id", userId).limit(10);
    if (error) {
        console.error("Push subscription lookup failed:", error.message);
        return;
    }
    if (!subscriptions?.length) return;

    const sessionIds = [...new Set(subscriptions.map(item => item.session_id).filter(Boolean))];
    const { data: activeSessions, error: sessionsError } = await supabase.from("at_user_sessions")
        .select("id").in("id", sessionIds.length ? sessionIds : ["00000000-0000-0000-0000-000000000000"])
        .is("revoked_at", null).gt("expires_at", new Date().toISOString());
    if (sessionsError) throw sessionsError;
    const active = new Set((activeSessions || []).map(session => session.id));

    const title = isGroup ? (chatName || "AchieveTogether") : (senderName || senderNick || "AchieveTogether");
    const body = safeBody(message.content) || (message.files?.length ? "New attachment" : "New message");
    const url = isGroup
        ? "/chat/g/" + encodeURIComponent(String(chatId))
        : "/chat/" + encodeURIComponent(String(senderNick || ""));
    const payload = { title, body, url, tag: "at-chat-" + String(chatId), messageId: message.id };

    await Promise.allSettled(subscriptions.map(async subscription => {
        if (!subscription.session_id || !active.has(subscription.session_id) || !validPushEndpoint(subscription.endpoint)) {
            await supabase.from("at_push_subscriptions").delete()
                .eq("endpoint_hash", subscription.endpoint_hash).eq("user_id", userId);
            return;
        }
        try {
            const result = await sendWebPush({
                endpoint: subscription.endpoint,
                expirationTime: subscription.expiration_time,
                keys: { p256dh: subscription.p256dh, auth: subscription.auth }
            }, payload);
            if (result.status === 404 || result.status === 410) {
                await supabase.from("at_push_subscriptions").delete()
                    .eq("endpoint_hash", subscription.endpoint_hash).eq("user_id", userId);
            } else if (!result.delivered && result.status !== 503) {
                console.warn("Push provider returned status:", result.status);
            }
        } catch (error) {
            console.warn("Push delivery failed:", error.message);
        }
    }));
}
