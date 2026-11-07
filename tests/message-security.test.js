import test from "node:test";
import assert from "node:assert/strict";
import reactions from "../routes/chat/reaction.js";
import pins from "../routes/chat/pinmess.js";
import media from "../routes/chat/ChatMedia.js";
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

async function call(register, route, db, user, body, params = { id: "1" }) {
    const routes = new Map();
    const app = Object.fromEntries(["get", "post", "patch"].map(method => [method,
        (path, ...handlers) => routes.set(path, handlers.at(-1))]));
    register(app, db);
    const result = { status: 200 };
    const res = {
        status(value) { result.status = value; return res; },
        json(value) { result.body = value; return res; }
    };
    await routes.get(route)({ user: user ? { id: user } : null, body, params, files: [] }, res);
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

test("anonymous requests cannot send messages, pin messages or list private media", async () => {
    const db = database();
    const routes = [
        [chats, "/chat", { chat_id: 10, text: "hello" }],
        [pins, "/pinmess", { message_id: 1 }],
        [media, "/media/:type/:id", {}]
    ];
    for (const [register, route, body] of routes) {
        const result = await call(register, route, db, null, body);
        assert.equal(result.status, 401);
    }
    assert.deepEqual(db.writes, []);
});

test("non-member and blocked members cannot pin group messages", async () => {
    for (const user of ["outsider", "blocked", "member"]) {
        const db = database();
        const result = await call(pins, "/pinmess", db, user, { message_id: 1 });
        assert.equal(result.status, 403);
        assert.deepEqual(db.writes, []);
    }
});

test("a member cannot forward a message from a different private chat", async () => {
    const db = database();
    db.rows.messages.push({ id: 2, chat_id: 11, sender_id: "stranger", hidden: [] });
    const result = await call(chats, "/chat", db, "owner", { chat_id: 10, redirect: "[2]" });
    assert.equal(result.status, 403);
    assert.deepEqual(db.writes, []);
});

test("forwarding a hidden message is forbidden even for its former chat member", async () => {
    const db = database();
    db.rows.messages[0].hidden = ["owner"];
    const result = await call(chats, "/chat", db, "owner", { chat_id: 10, redirect: "[1]" });
    assert.equal(result.status, 403);
    assert.deepEqual(db.writes, []);
});

test("malformed forwarded IDs do not cause writes", async () => {
    for (const redirect of ["not-json", "[\"not-a-number\"]", "[0]", "{}"]) {
        const db = database();
        const result = await call(chats, "/chat", db, "owner", { chat_id: 10, redirect });
        assert.equal(result.status, 400);
        assert.deepEqual(db.writes, []);
    }
});

test("reply cannot point to a message from another chat", async () => {
    const db = database();
    db.rows.messages.push({ id: 2, chat_id: 11, sender_id: "stranger", hidden: [] });
    const result = await call(chats, "/chat", db, "owner", { chat_id: 10, text: "reply", answer_id: 2 });
    assert.equal(result.status, 403);
    assert.deepEqual(db.writes, []);
});

test("blocked group member cannot send messages", async () => {
    const db = database();
    const result = await call(chats, "/chat", db, "blocked", { chat_id: 10, text: "blocked" });
    assert.equal(result.status, 403);
    assert.deepEqual(db.writes, []);
});

test("anonymous users cannot read private or group chat history", async () => {
    const db = database();
    for (const [route, params] of [
        ["/chat/:nick", { nick: "member" }],
        ["/chat/group/:id", { id: "10" }]
    ]) {
        const result = await call(chats, route, db, null, {}, params);
        assert.equal(result.status, 401);
    }
    assert.deepEqual(db.writes, []);
});

test("blocked group member cannot load chat messages", async () => {
    const db = database();
    const result = await call(chats, "/chat/group/:id", db, "blocked", {}, { id: "10" });
    assert.equal(result.status, 403);
    assert.deepEqual(db.writes, []);
});
