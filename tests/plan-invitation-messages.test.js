import test from "node:test";
import assert from "node:assert/strict";
import { readPlanInvitation } from "../services/planInvitations.js";

const owner = "11111111-1111-4111-8111-111111111111";
const target = "22222222-2222-4222-8222-222222222222";
const outsider = "33333333-3333-4333-8333-333333333333";

function fixture() {
    const rows = {
        messages: [{ id: 15, chat_id: 3, sender_id: owner, plan_invite_plan_id: 7,
            plan_invite_recipient_id: target, hidden: [] }],
        chat_members: [{ id: 1, chat_id: 3, user_id: owner, is_blocked: false },
            { id: 2, chat_id: 3, user_id: target, is_blocked: false }],
        one_off_plans: [{ id: 7, name: "Weekend", tag: "games", status: "upcoming",
            plan_date: "2026-11-20", start_time: null, end_time: null }],
        one_off_plan_members: [{ plan_id: 7, user_id: target, status: "pending", invitation_message_id: 15 }]
    };
    const supabase = { from(table) {
        const predicates = [];
        const query = {
            select() { return query; },
            eq(column, value) { predicates.push(row => String(row[column]) === String(value)); return query; },
            async maybeSingle() {
                return { data: rows[table].find(row => predicates.every(predicate => predicate(row))) || null, error: null };
            }
        };
        return query;
    } };
    return { rows, supabase };
}

test("plan invitation card is visible only to the sender or recipient within the chat", async () => {
    const { supabase } = fixture();
    assert.equal(await readPlanInvitation(supabase, 15, outsider), null);
    const received = await readPlanInvitation(supabase, 15, target);
    assert.equal(received.plan.name, "Weekend");
    assert.equal(received.status, "pending");
    assert.equal(received.can_respond, true);
    const sent = await readPlanInvitation(supabase, 15, owner);
    assert.equal(sent.can_respond, false);
});

test("revoking or answering an invitation disables the message buttons", async () => {
    const { rows, supabase } = fixture();
    rows.one_off_plan_members[0].status = "accepted";
    assert.equal((await readPlanInvitation(supabase, 15, target)).can_respond, false);
    rows.one_off_plan_members[0].invitation_message_id = 99;
    assert.equal((await readPlanInvitation(supabase, 15, target)).status, "cancelled");
    rows.one_off_plan_members.length = 0;
    assert.equal((await readPlanInvitation(supabase, 15, target)).status, "cancelled");
});

test("blocking recipient chat membership removes access to invitation content", async () => {
    const { rows, supabase } = fixture();
    rows.chat_members[1].is_blocked = true;
    assert.equal(await readPlanInvitation(supabase, 15, target), null);
});

test("completed/cancelled plan invitations cannot be newly accepted", async () => {
    const { rows, supabase } = fixture();
    rows.one_off_plans[0].status = "canceled";
    assert.equal((await readPlanInvitation(supabase, 15, target)).can_respond, false);
});
