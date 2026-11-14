import test from "node:test";
import assert from "node:assert/strict";
import registerHabitMembers from "../routes/habits/members.js";

test("activity invitation cannot be accepted outside its message card", async () => {
    const handlers = new Map();
    const app = {
        get(path, ...args) { handlers.set("GET " + path, args.at(-1)); },
        post(path, ...args) { handlers.set("POST " + path, args.at(-1)); },
        patch(path, ...args) { handlers.set("PATCH " + path, args.at(-1)); },
        delete(path, ...args) { handlers.set("DELETE " + path, args.at(-1)); }
    };
    let queries = 0;
    const supabase = { rpc() { queries++; throw new Error("Should never be reached"); } };
    registerHabitMembers(app, supabase);
    const handler = handlers.get("PATCH /habits/:id/members/me");
    assert.equal(typeof handler, "function");
    for (const body of [{ status: "accepted" }, { status: "declined" },
        { status: "accepted", message_id: null }, { status: "accepted", message_id: 0 },
        { status: "accepted", message_id: "15" }]) {
        let status = 200, payload = null;
        const res = {
            status(value) { status = value; return res; },
            json(value) { payload = value; return res; }
        };
        await handler({ user: { id: "member" }, params: { id: "19" }, body }, res);
        assert.equal(status, 400);
        assert.equal(payload.success, false);
    }
    assert.equal(queries, 0);
});
