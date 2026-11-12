import test from "node:test";
import assert from "node:assert/strict";
import registerPlans from "../routes/plans/plans.js";

const owner = "11111111-1111-4111-8111-111111111111";
const member = "22222222-2222-4222-8222-222222222222";
const pending = "33333333-3333-4333-8333-333333333333";
const outsider = "44444444-4444-4444-8444-444444444444";

function server() {
    const rows = {
        one_off_plans: [{ id: 1, owner_id: owner, name: "Private", plan_date: "2026-11-20" }],
        one_off_plan_members: [
            { plan_id: 1, user_id: owner, status: "accepted", pinned: false },
            { plan_id: 1, user_id: member, status: "accepted", pinned: false },
            { plan_id: 1, user_id: pending, status: "pending", pinned: false }
        ]
    };
    let writes = 0;
    const supabase = { from(table) {
        const predicates = [];
        let mutation = null;
        const query = {
            select() { return query; },
            eq(key, value) { predicates.push(row => String(row[key]) === String(value)); return query; },
            update(patch) { mutation = patch; return query; },
            async maybeSingle() {
                const row = (rows[table] || []).find(item => predicates.every(test => test(item)));
                if (row && mutation) { Object.assign(row, mutation); writes++; }
                return { data: row ? { ...row } : null, error: null };
            }
        };
        return query;
    }};
    const routes = new Map();
    const app = {};
    for (const method of ["get","post","patch","delete"])
        app[method] = (path,...handlers) => routes.set(method.toUpperCase()+" "+path, handlers.at(-1));
    registerPlans(app,supabase);
    const send = async (userId, body) => {
        const handler = routes.get("PATCH /plans/:id/pin");
        let status = 200;
        let payload;
        const res = { status(value) { status = value; return res; }, json(value) { payload = value; return res; } };
        await handler({ user: userId ? { id: userId } : null, params: { id: "1" }, body },res);
        return { status, payload };
    };
    return { send, rows, writes: () => writes };
}

test("pin is private to the accepted member and persists in membership", async () => {
    const app = server();
    assert.equal((await app.send(owner, { pinned: true })).payload.pinned, true);
    assert.equal(app.rows.one_off_plan_members[0].pinned, true);
    assert.equal(app.rows.one_off_plan_members[1].pinned, false);
    assert.equal((await app.send(member, { pinned: true })).payload.pinned, true);
    assert.equal((await app.send(owner, { pinned: false })).payload.pinned, false);
    assert.equal(app.rows.one_off_plan_members[1].pinned, true);
});

test("pending, strangers, unauthenticated users and malformed input cannot pin", async () => {
    const app = server();
    assert.equal((await app.send(pending, { pinned: true })).status, 403);
    assert.equal((await app.send(outsider, { pinned: true })).status, 404);
    assert.equal((await app.send(null, { pinned: true })).status, 401);
    for (const body of [{ pinned: 1 }, { pinned: true, owner_id: outsider }, {}])
        assert.equal((await app.send(owner, body)).status, 400);
    assert.equal(app.writes(), 0);
});
