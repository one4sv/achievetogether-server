import { publishHabitInvitation } from "./habitInvitations.js";

export async function publishPlanInvitation(supabase, messageId, edited = false) {
    return publishHabitInvitation(supabase, messageId, edited, "PLAN_INVITATION_UPDATED");
}

export async function sendPlanInvitation(supabase, ownerId, planId, targetId) {
    const { data, error } = await supabase.rpc("send_plan_invitation", {
        p_actor: ownerId, p_plan: Number(planId), p_target: targetId
    });
    if (error) throw error;
    if (data.message_id && !data.already_invited) await publishPlanInvitation(supabase, data.message_id);
    return data;
}

export async function readPlanInvitation(supabase, messageId, viewerId) {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return null;
    const { data: message, error } = await supabase.from("messages")
        .select("id,chat_id,sender_id,plan_invite_plan_id,plan_invite_recipient_id,hidden")
        .eq("id", messageId).maybeSingle();
    if (error) throw error;
    if (!message?.plan_invite_plan_id || !message.plan_invite_recipient_id ||
        message.hidden?.includes(viewerId) ||
        (message.sender_id !== viewerId && message.plan_invite_recipient_id !== viewerId)) return null;
    const { data: chatMember, error: memberError } = await supabase.from("chat_members")
        .select("id,is_blocked").eq("chat_id", message.chat_id).eq("user_id", viewerId).maybeSingle();
    if (memberError) throw memberError;
    if (!chatMember || chatMember.is_blocked) return null;
    const { data: plan, error: planError } = await supabase.from("one_off_plans")
        .select("id,name,tag,plan_date,start_time,end_time,status")
        .eq("id", message.plan_invite_plan_id).maybeSingle();
    if (planError) throw planError;
    if (!plan) return null;
    const { data: member, error: planMemberError } = await supabase.from("one_off_plan_members")
        .select("status,invitation_message_id").eq("plan_id", plan.id)
        .eq("user_id", message.plan_invite_recipient_id).maybeSingle();
    if (planMemberError) throw planMemberError;
    const status = member?.invitation_message_id === messageId ? member.status : "cancelled";
    return { plan, status,
        can_respond: viewerId === message.plan_invite_recipient_id &&
            status === "pending" && plan.status !== "canceled" };
}
