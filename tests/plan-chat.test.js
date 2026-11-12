import assert from "node:assert/strict";
import test from "node:test";
import { linkPlanToGroup } from "../services/planChatLink.js";

const owner = "11111111-1111-4111-8111-111111111111";
const participant = "22222222-2222-4222-8222-222222222222";
const stranger = "33333333-3333-4333-8333-333333333333";

function fixture({ blocked = false, denyInvites = false, existingChat = null } = {}) {
    const rows = {
        one_off_plans: [{ id: 7, owner_id: owner, chat_id: existingChat, kind: "personal", status: "upcoming" }],
        chats: [{ id: 10, is_group: true }, { id: 11, is_group: true }],
        chat_members: [
            { chat_id: 10, user_id: owner, is_blocked: false },
            { chat_id: 10, user_id: participant, is_blocked: blocked }
        ],
        one_off_plan_members: [{ plan_id: 7, user_id: owner, status: "accepted" }],
        settings: [{ user_id: participant, private: { plan_invites: denyInvites ? "nobody" : "all" } }]
    };
    let writes = 0;
    const supabase = { from(table) {
        const tests = [];
        let operation = "select";
        let payload;
        const matches = row => tests.every(testRow => testRow(row));
        const result = () => {
            let matched = (rows[table] || []).filter(matches);
            if (operation === "update") {
                writes++;
                matched.forEach(row => Object.assign(row, payload));
            } else if (operation === "upsert") {
                writes++;
                for (const item of Array.isArray(payload) ? payload : [payload]) {
                    const previous = (rows[table] || []).find(row => row.plan_id === item.plan_id && row.user_id === item.user_id);
                    if (previous) Object.assign(previous, item);
                    else rows[table].push(item);
                }
            }
            return { data: matched, error: null };
        };
        const query = {
            select() { return query; },
            eq(column, value) {
                tests.push(row => String(row[column]) === String(value));
                return query;
            },
            in(column, values) {
                tests.push(row => values.map(String).includes(String(row[column])));
                return query;
            },
            is(column, value) {
                tests.push(row => row[column] === value);
                return query;
            },
            update(value) { operation = "update"; payload = value; return query; },
            upsert(value) { operation = "upsert"; payload = value; return query; },
            maybeSingle() {
                const res = result();
                return Promise.resolve({ data: res.data[0] || null, error: null });
            },
            then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); }
        };
        return query;
    }};
    return { rows, supabase, getWrites: () => writes };
}

test("plan owner links a group and sends pending invitations rather than automatic private access", async () => {
    const { rows, supabase } = fixture();
    const result = await linkPlanToGroup(supabase, 7, 10, owner);
    assert.equal(result.invited, 1);
    assert.equal(rows.one_off_plans[0].chat_id, 10);
    assert.equal(rows.one_off_plans[0].kind, "shared");
    assert.equal(rows.one_off_plan_members.find(m => m.user_id === participant)?.status, "pending");
});
test("a non-owner cannot attach plans or invite participants", async () => {
    const { supabase, getWrites } = fixture();
    await assert.rejects(() => linkPlanToGroup(supabase, 7, 10, stranger), { status: 403 });
    assert.equal(getWrites(), 0);
});
test("owner must already belong to a real group chat", async () => {
    const { supabase, getWrites } = fixture();
    await assert.rejects(() => linkPlanToGroup(supabase, 7, 11, owner), { status: 403 });
    assert.equal(getWrites(), 0);
});
test("blocked chat members and users who disallow plan invites do not get invitations", async () => {
    for (const settings of [{ blocked: true }, { denyInvites: true }]) {
        const { rows, supabase } = fixture(settings);
        const result = await linkPlanToGroup(supabase, 7, 10, owner);
        assert.equal(result.invited, 0);
        assert.equal(rows.one_off_plan_members.length, 1);
    }
});
test("linking a plan to a different group is rejected without mutations", async () => {
    const { supabase, getWrites } = fixture({ existingChat: 11 });
    await assert.rejects(() => linkPlanToGroup(supabase, 7, 10, owner), { status: 409 });
    assert.equal(getWrites(), 0);
});
