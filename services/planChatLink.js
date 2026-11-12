// Shared by /plans/:id/chat and the existing CreateChat flow.
// A linked group never gets private plan access implicitly: its members
// receive ordinary pending invitations and must accept them.
const issue = (status, message) => Object.assign(new Error(message), { status });

export async function linkPlanToGroup(supabase, planId, chatId, ownerId) {
    if (!Number.isSafeInteger(Number(planId)) || Number(planId) <= 0 ||
        !Number.isSafeInteger(Number(chatId)) || Number(chatId) <= 0)
        throw issue(400, "Некорректный ID плана или беседы");

    const { data: plan, error: planError } = await supabase.from("one_off_plans")
        .select("id,owner_id,chat_id,kind,status").eq("id", planId).maybeSingle();
    if (planError) throw planError;
    if (!plan) throw issue(404, "План не найден");
    if (plan.owner_id !== ownerId) throw issue(403, "Только владелец может связать план с беседой");
    if (plan.status !== "upcoming") throw issue(409, "Нельзя изменить беседу завершённого или отменённого плана");
    if (plan.chat_id && Number(plan.chat_id) !== Number(chatId))
        throw issue(409, "План уже привязан к другой беседе");

    const { data: chat, error: chatError } = await supabase.from("chats")
        .select("id,is_group").eq("id", chatId).maybeSingle();
    if (chatError) throw chatError;
    if (!chat?.is_group) throw issue(404, "Групповая беседа не найдена");

    const { data: participants, error: membersError } = await supabase.from("chat_members")
        .select("user_id,is_blocked").eq("chat_id", chatId);
    if (membersError) throw membersError;
    const members = (participants || []).filter(item => !item.is_blocked);
    if (!members.some(item => item.user_id === ownerId))
        throw issue(403, "Владелец плана должен состоять в этой беседе");

    const { data: existing, error: existingError } = await supabase.from("one_off_plan_members")
        .select("user_id,status").eq("plan_id", plan.id);
    if (existingError) throw existingError;
    const already = new Set((existing || [])
        .filter(item => item.status === "accepted" || item.status === "pending")
        .map(item => item.user_id));
    const candidates = [...new Set(members.map(m => m.user_id))]
        .filter(userId => userId !== ownerId && !already.has(userId));

    let invites = [];
    if (candidates.length) {
        const { data: settings, error: settingsError } = await supabase.from("settings")
            .select("user_id,private").in("user_id", candidates);
        if (settingsError) throw settingsError;
        const settingsById = new Map((settings || []).map(item => [item.user_id, item.private]));
        invites = candidates.filter(id =>
            (settingsById.get(id)?.plan_invites ?? settingsById.get(id)?.activity_invites) !== "nobody")
            .map(userId => ({
                plan_id: plan.id, user_id: userId, invited_by: ownerId,
                status: "pending", joined_at: null
            }));
    }

    const changed = !plan.chat_id || plan.kind !== "shared";
    if (changed) {
        const { data: linked, error } = await supabase.from("one_off_plans")
            .update({ chat_id: chatId, kind: "shared", updated_at: new Date().toISOString() })
            .eq("id", plan.id).eq("owner_id", ownerId)
            .is("chat_id", null).select("id").maybeSingle();
        if (error) throw error;
        if (!linked) throw issue(409, "План уже привязан к беседе");
    }

    if (invites.length) {
        const { error } = await supabase.from("one_off_plan_members")
            .upsert(invites, { onConflict: "plan_id,user_id" });
        if (error) {
            // A failed invite must not silently leave an incomplete link.
            if (changed) {
                const { error: rollback } = await supabase.from("one_off_plans")
                    .update({ chat_id: plan.chat_id ?? null, kind: plan.kind })
                    .eq("id", plan.id).eq("owner_id", ownerId).eq("chat_id", chatId);
                if (rollback) console.error("[plan/chat] Link rollback failed:", rollback);
            }
            throw error;
        }
    }
    return { chat_id: chatId, invited: invites.length };
}
