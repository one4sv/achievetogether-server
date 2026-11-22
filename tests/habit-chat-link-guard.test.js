import assert from "node:assert/strict";
import test from "node:test";
import registerHabitMembers from "../routes/habits/members.js";

test("chat /invite must not move an activity linked to another group", async () => {
    const handlers = new Map();
    const app = {
        get(path, ...args) { handlers.set("GET " + path, args.at(-1)); },
        post(path, ...args) { handlers.set("POST " + path, args.at(-1)); },
        patch(path, ...args) { handlers.set("PATCH " + path, args.at(-1)); },
        delete(path, ...args) { handlers.set("DELETE " + path, args.at(-1)); }
    };
    const supabase = {
        from(table) {
            assert.equal(table, "habits", "No other table should be queried when a move is denied");
            return {
                select() { return this; },
                eq() { return this; },
                maybeSingle: async () => ({
                    data: { id: 7, user_id: "owner", chat_id: 9 }, error: null
                }),
                update() { throw new Error("Unsafe activity reparenting"); }
            };
        }
    };
    registerHabitMembers(app, supabase);
    const handler = handlers.get("PATCH /habits/:id/chat");
    assert.equal(typeof handler, "function");
    let code = 200, body = null;
    const res = {
        status(value) { code = value; return res; },
        json(value) { body = value; return res; }
    };
    await handler({ user: { id: "owner" }, params: { id: "7" },
        body: { chat_id: 10, only_if_unlinked: true } }, res);
    assert.equal(code, 409);
    assert.deepEqual(body, { success: false, error: "Активность уже привязана к другой беседе" });
});
