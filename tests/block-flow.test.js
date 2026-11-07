import test from "node:test";
import assert from "node:assert/strict";
import chats from "../routes/chat/chat.js";
import toggleblocked from "../routes/chat/toggleblocked.js";

const owner = "11111111-1111-4111-8111-111111111111";
const friend = "22222222-2222-4222-8222-222222222222";

function database() {
    const rows = {
        users: [
            { id: owner, nick: "owner", username: "Owner" },
            { id: friend, nick: "friend", username: "Friend" }
        ],
        chats: [{ id: 10, is_group: true }],
        chat_members: [
            { chat_id: 10, user_id: owner, is_blocked: false },
            { chat_id: 10, user_id: friend, is_blocked: false }
        ],
        messages: []
    };
    const writes = [];
    return { rows, writes, from(table) {
        const filters = [];
        let single = false, mutation = null, mutationData = null, limit = 1000;
        const query = {
            select() { return query; },
            eq(key, value) {
                filters.push(row => key === "chats.is_group"
                    ? rows.chats.find(chat => chat.id === row.chat_id)?.is_group === value
                    : row[key] === value);
                return query;
            },
            in(key, values) { filters.push(row => values.includes(row[key])); return query; },
            not() { return query; },
            order() { return query; },
            limit(number) { limit = number; return query; },
            single() { single = true; return query; },
            maybeSingle() { single = true; return query; },
            insert(value) { mutation = "insert"; mutationData = value; return query; },
            update(value) { mutation = "update"; mutationData = value; return query; },
            then(resolve, reject) {
                let data = rows[table].filter(row => filters.every(check => check(row))).slice(0, limit);
                if (mutation === "insert") {
                    const list = Array.isArray(mutationData) ? mutationData : [mutationData];
                    data = list.map(item => table === "chats" ? { ...item, id: 20 } : { ...item });
                    rows[table].push(...data);
                    writes.push({ table, mutation });
                } else if (mutation === "update") {
                    data.forEach(row => Object.assign(row, mutationData));
                    writes.push({ table, mutation });
                }
                return Promise.resolve({ data: single ? data[0] ?? null : data, error: null }).then(resolve, reject);
            }
        };
        return query;
    } };
}

async function invoke(register, route, db, user, body, params = {}) {
    const routes = new Map();
    const app = Object.fromEntries(["post", "get", "patch"].map(method =>
        [method, (path, ...handlers) => routes.set(path, handlers.at(-1))]));
    register(app, db);
    const result = { status: 200 };
    const res = {
        status(code) { result.status = code; return res; },
        json(data) { result.body = data; return res; }
    };
    await routes.get(route)({ user: { id: user }, body, params, query: {}, files: [] }, res);
    return result;
}

test("blocking from a profile never bans the same user from a two-member group", async () => {
    const db = database();
    const result = await invoke(toggleblocked, "/toggleblocked", db, owner, { id: friend });
    assert.equal(result.status, 200);
    assert.equal(result.body.is_blocked, true);
    assert.equal(db.rows.chats.length, 2);
    assert.equal(db.rows.chats[1].is_group, false);
    assert.equal(db.rows.chat_members.find(row => row.chat_id === 10 && row.user_id === owner).is_blocked, false);
    assert.equal(db.rows.chat_members.find(row => row.chat_id === 20 && row.user_id === owner).is_blocked, true);
});

test("blocked personal chats remain readable and become writable only after unblock", async () => {
    const db = database();
    assert.equal((await invoke(toggleblocked, "/toggleblocked", db, owner, { id: friend })).body.is_blocked, true);
    const chat = await invoke(chats, "/chat/:nick", db, owner, null, { nick: "friend" });
    assert.equal(chat.status, 200);
    assert.equal(chat.body.user.is_blocked, true);
    assert.deepEqual(chat.body.messages, []);

    const before = db.writes.length;
    const denied = await invoke(chats, "/chat", db, owner, { receiver_nick: "friend", text: "test" });
    assert.equal(denied.status, 403);
    assert.equal(db.writes.length, before);

    const unblocked = await invoke(toggleblocked, "/toggleblocked", db, owner, { id: friend });
    assert.equal(unblocked.status, 200);
    assert.equal(unblocked.body.is_blocked, false);
    assert.equal(db.rows.chat_members.find(row => row.chat_id === 20 && row.user_id === owner).is_blocked, false);
});

test("self-block and unknown users are rejected", async () => {
    const db = database();
    assert.equal((await invoke(toggleblocked, "/toggleblocked", db, owner, { id: owner })).status, 400);
    assert.equal((await invoke(toggleblocked, "/toggleblocked", db, owner, { id: "33333333-3333-4333-8333-333333333333" })).status, 404);
    assert.deepEqual(db.writes, []);
});
