import test from "node:test";
import assert from "node:assert/strict";
import reactions from "../routes/chat/reaction.js";
import deletes from "../routes/system/delete.js";
import chats from "../routes/chat/chat.js";
import initWebSocket from "../realtime/ws.js";
import { createServer } from "node:http";

function database(overrides = {}) {
    const rows = {
        messages: [{ id: 1, chat_id: 10, sender_id: "owner", reactions: [], read_by: [], hidden: [] }],
        chat_members: [
            { chat_id: 10, user_id: "owner", is_blocked: false },
            { chat_id: 10, user_id: "member", is_blocked: false },
            { chat_id: 10, user_id: "blocked", is_blocked: true }
        ],
        chats: [{ id: 10, creator_id: "owner", is_group: true }],
        ...overrides
    };
    const writes = [];
    return { rows, writes, from(table) {
        const filters = [];
        let operation, values, one = false, limit = Infinity;
        const query = {
            select() { return query; },
            eq(key, value) { filters.push(row => row[key] === value); return query; },
            in(key, values) { filters.push(row => values.includes(row[key])); return query; },
            limit(value) { limit = value; return query; },
            single() { one = true; return query; },
            maybeSingle() { one = true; return query; },
            update(value) { operation = "update"; values = value; return query; },
            delete() { operation = "delete"; return query; },
            then(resolve, reject) {
                let data = (rows[table] || []).filter(row => filters.every(filter => filter(row))).slice(0, limit);
                if (operation) {
                    writes.push({ table, operation, ids: data.map(row => row.id), values });
                    if (operation === "update") data.forEach(row => Object.assign(row, values));
                    else rows[table] = rows[table].filter(row => !data.includes(row));
                }
                return Promise.resolve({ data: one ? data[0] || null : data, error: null }).then(resolve, reject);
            }
        };
        return query;
    } };
}

async function call(register, route, db, user, body) {
    const routes = new Map();
    const app = Object.fromEntries(["get", "post", "patch"].map(method => [method,
        (path, ...handlers) => routes.set(path, handlers.at(-1))]));
    register(app, db);
    const result = { status: 200 };
    const res = {
        status(value) { result.status = value; return res; },
        json(value) { result.body = value; return res; }
    };
    await routes.get(route)({ user: user ? { id: user } : null, body, params: { id: "1" }, files: [] }, res);
    return result;
}

for (const user of [null, "outsider", "blocked"]) {
    test(`reaction and read reject ${user || "anonymous"} without mutations`, async () => {
        for (const [register, route, body] of [
            [reactions, "/reactions", { mId: 1, reaction: "👍" }],
            [chats, "/chat/read", { messageId: 1 }]
        ]) {
            const db = database();
            const result = await call(register, route, db, user, body);
            assert.equal(result.status, user ? 403 : 401);
            assert.deepEqual(db.writes, []);
        }
    });
}

test("ordinary member cannot delete somebody else's message for everyone", async () => {
    const db = database();
    assert.equal((await call(deletes, "/delete", db, "member", { goal: "messForAll", delete_id: 1 })).status, 403);
    assert.deepEqual(db.writes, []);
});

test("deleting a personal chat cannot delete a shared group", async () => {
    const db = database();
    assert.equal((await call(deletes, "/delete", db, "member", { goal: "chat", delete_id: "owner" })).status, 403);
    assert.deepEqual(db.writes, []);
});

test("personal chat deletion selects the personal conversation even when group comes first", async () => {
    const db = database();
    db.rows.chats.push({ id: 20, is_group: false });
    db.rows.chat_members.push({ chat_id: 20, user_id: "owner" }, { chat_id: 20, user_id: "member" });
    assert.equal((await call(deletes, "/delete", db, "member", { goal: "chat", delete_id: "owner" })).status, 200);
    assert.deepEqual(db.rows.chats.map(row => row.id), [10]);
    assert.equal(db.rows.messages.length, 1);
});

test("former author cannot edit a message after leaving the chat", async () => {
    const db = database({ chat_members: [] });
    assert.equal((await call(chats, "/messages/:id", db, "owner", { text: "replacement" })).status, 403);
    assert.deepEqual(db.writes, []);
});

test("hidden message cannot receive reactions", async () => {
    const db = database();
    db.rows.messages[0].hidden = ["member"];
    assert.equal((await call(reactions, "/reactions", db, "member", { mId: 1, reaction: "👍" })).status, 403);
    assert.deepEqual(db.writes, []);
});

test("member can react and read; author can delete their own message", async t => {
    const db = database();
    const server = createServer();
    const wss = initWebSocket(db, server);
    t.after(() => { wss.close(); server.close(); });
    assert.equal((await call(reactions, "/reactions", db, "member", { mId: 1, reaction: "👍" })).status, 200);
    assert.deepEqual(db.rows.messages[0].reactions, [{ user_id: "member", reaction: "👍" }]);
    assert.equal((await call(chats, "/chat/read", db, "member", { messageId: 1 })).status, 200);
    assert.deepEqual(db.rows.messages[0].read_by, ["member"]);
    assert.equal((await call(deletes, "/delete", db, "owner", { goal: "messForAll", delete_id: 1 })).status, 200);
    assert.deepEqual(db.rows.messages, []);
});
