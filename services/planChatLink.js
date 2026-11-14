import { sendPlanInvitation, publishPlanInvitation } from "./planInvitations.js";
import { ownerPrivacy, relationship, permitted } from "../utils/privacy.js";

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

    const invites = [];
    for (const userId of candidates) {
        const [privacy, rel] = await Promise.all([
            ownerPrivacy(supabase,userId), relationship(supabase,ownerId,userId)
        ]);
        if (permitted({ rules:privacy.rules,field:"plan_invites",
            viewerId:ownerId,ownerId:userId,contact:rel.contact,blocked:rel.blocked })) {
            invites.push({ user_id:userId });
        }
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
        const { data, error } = await supabase.rpc("send_plan_invitations_batch", {
            p_actor: ownerId, p_plan: plan.id, p_targets: invites.map(invite => invite.user_id)
        });
        if (error) {
            if (changed) {
                const { error: rollback } = await supabase.from("one_off_plans")
                    .update({ chat_id: plan.chat_id ?? null, kind: plan.kind })
                    .eq("id", plan.id).eq("owner_id", ownerId).eq("chat_id", chatId);
                if (rollback) console.error("[plan/chat] Link rollback failed:", rollback);
            }
            throw error;
        }
        for (const result of data?.results || []) {
            if (result.message_id && !result.already_invited)
                await publishPlanInvitation(supabase,result.message_id);
        }
    }
    return { chat_id: chatId, invited: invites.length };
}


/** Called after a user joins a group already linked to one or more plans. */
export async function inviteJoinedGroupMemberToPlans(supabase, chatId, userId) {
    const { data: plans, error: plansError } = await supabase.from("one_off_plans")
        .select("id,owner_id").eq("chat_id", chatId).eq("status", "upcoming");
    if (plansError) throw plansError;
    if (!plans?.length) return 0;
    const ids = plans.filter(plan => plan.owner_id !== userId).map(plan => plan.id);
    if (!ids.length) return 0;
    const { data: existing, error: membersError } = await supabase.from("one_off_plan_members")
        .select("plan_id,status").eq("user_id", userId).in("plan_id", ids);
    if (membersError) throw membersError;
    const already = new Set((existing || [])
        .filter(member => member.status === "pending" || member.status === "accepted")
        .map(member => String(member.plan_id)));
    const candidates = plans.filter(plan => plan.owner_id !== userId && !already.has(String(plan.id)));
    if (!candidates.length) return 0;
    let invited = 0;
    const privacy = await ownerPrivacy(supabase,userId);
    for (const plan of candidates) {
        const rel = await relationship(supabase,plan.owner_id,userId);
        if (!permitted({ rules:privacy.rules,field:"plan_invites",
            viewerId:plan.owner_id,ownerId:userId,contact:rel.contact,blocked:rel.blocked })) continue;
        const result = await sendPlanInvitation(supabase,plan.owner_id,plan.id,userId);
        if (!result.already_invited && !result.already_member) invited++;
    }
    return invited;
}
