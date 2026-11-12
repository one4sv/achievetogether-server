import test from "node:test";
import assert from "node:assert/strict";
import registerDelete from "../routes/system/delete.js";

const owner = "11111111-1111-4111-8111-111111111111";
const outsider = "22222222-2222-4222-8222-222222222222";

function makeServer({ error = null } = {}) {
    const habits = [{ id: 12, user_id: owner }];
    let deleted = false;
    const db = { from(table) {
        assert.equal(table, "habits");
        const checks = [];
        let mode = "select";
        const query = {
            select() { return query; },
            eq(key, value) {
                checks.push(row => String(row[key]) === String(value));
                return query;
            },
            maybeSingle() {
                return Promise.resolve({ data: habits.find(row => checks.every(check => check(row))) || null, error: null });
            },
            delete() { mode = "delete"; return query; },
            then(resolve, reject) {
                if (mode !== "delete") throw new Error("Unexpected query");
                const count = habits.filter(row => checks.every(check => check(row))).length;
                if (count && !error) deleted = true;
                return Promise.resolve({ error, count: error ? null : count }).then(resolve, reject);
            }
        };
        return query;
    }};
    let handler;
    registerDelete({ post(path, ...handlers) {
        if (path === "/delete") handler = handlers.at(-1);
    } }, db);
    const call = async (userId, deleteId = 12) => {
        let status = 200, payload;
        const res = {
            status(value) { status = value; return res; },
            json(value) { payload = value; return res; }
        };
        await handler({ user: { id: userId }, body: { goal: "habit", delete_id: deleteId } }, res);
        return { status, payload };
    };
    return { call, wasDeleted: () => deleted };
}

test("a valid activity owner can delete without relying on a post-delete SELECT projection", async () => {
    const server = makeServer();
    const { status, payload } = await server.call(owner);
    assert.equal(status, 200);
    assert.equal(payload.success, true);
    assert.equal(server.wasDeleted(), true);
});
test("deleting someone else's activity never performs a database deletion", async () => {
    const server = makeServer();
    const response = await server.call(outsider);
    assert.equal(response.status, 404);
    assert.equal(server.wasDeleted(), false);
});
test("database errors are not disguised as an activity not found", async () => {
    const server = makeServer({ error: { code: "23503", message: "foreign key violation" } });
    const response = await server.call(owner);
    assert.equal(response.status, 500);
    assert.equal(server.wasDeleted(), false);
});
test("invalid habit IDs are rejected before database operations", async () => {
    const server = makeServer();
    const response = await server.call(owner, "NaN");
    assert.equal(response.status, 400);
    assert.equal(server.wasDeleted(), false);
});
