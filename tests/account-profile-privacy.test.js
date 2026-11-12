import test from "node:test";
import assert from "node:assert/strict";
import profileRoutes from "../routes/users/acc.js";

const owner = "11111111-1111-4111-8111-111111111111";
const friend = "22222222-2222-4222-8222-222222222222";
const outsider = "33333333-3333-4333-8333-333333333333";

function createDatabase({ blocked = false, habitVisibility = "contacts", presenceVisibility = "all" } = {}) {
    const rows = {
        users: [{
            id: owner, nick: "owner", username: "Owner", bio: "Hi",
            avatar_url: null, last_online: "2026-11-09T12:00:00Z",
            mail: "private@example.invalid", pass: "server-only-hash",
            auth_version: 9, deletion_requested_at: "2026-11-01T00:00:00Z"
        }],
        settings: [{ user_id: owner, show_archived_in_acc: true, private: {
            number: "contacts", mail: "contacts", habits: habitVisibility, posts: "all", presence: presenceVisibility
        } }],
        habits: [{ id: 19, user_id: owner, ongoing: true, name: "Private activity" }],
        posts: [],
        one_off_plans: [],
        chats: [{ id: 9, is_group: false }],
        chat_members: [
            { chat_id: 9, user_id: owner, is_blocked: false },
            { chat_id: 9, user_id: friend, is_blocked: blocked }
        ]
    };
    return { from(table) {
        const predicates = [];
        let columns = "*";
        const evaluate = () => {
            const filtered = rows[table].filter(row => predicates.every(predicate => predicate(row)));
            return filtered.map(row => columns === "*" ? { ...row } :
                Object.fromEntries(columns.split(",").map(key => key.trim()).filter(key => key in row).map(key => [key, row[key]])));
        };
        const query = {
            select(fields = "*") { columns = fields; return query; },
            eq(key, value) { predicates.push(row => key === "chats.is_group" ? rows.chats.find(chat => chat.id === row.chat_id)?.is_group === value : row[key] === value); return query; },
            in(key, values) { predicates.push(row => values.includes(row[key])); return query; },
            order() { return query; },
            limit() { return query; },
            maybeSingle() { return Promise.resolve({ data: evaluate()[0] || null, error: null }); },
            then(resolve, reject) { return Promise.resolve({ data: evaluate(), error: null }).then(resolve, reject); }
        };
        return query;
    } };
}

async function getAccount(db, viewerId) {
    const handlers = new Map();
    const app = { get(path, ...steps) { handlers.set(path, steps.at(-1)); } };
    profileRoutes(app, db);
    let status = 200;
    let payload;
    const res = {
        set() { return res; },
        status(next) { status = next; return res; },
        json(body) { payload = body; return res; }
    };
    await handlers.get("/acc/:nick")({ params: { nick: "owner" }, user: { id: viewerId } }, res);
    return { status, payload };
}

test("profile never returns password hashes, email or session metadata", async () => {
    for (const viewer of [owner, friend, outsider]) {
        const { status, payload } = await getAccount(createDatabase(), viewer);
        assert.equal(status, 200);
        assert.equal(payload.success, true);
        assert.equal(payload.acc.nick, "owner");
        for (const forbidden of ["pass", "mail", "auth_version", "deletion_requested_at"]) {
            assert.equal(Object.hasOwn(payload.acc, forbidden), false, forbidden);
        }
    }
});

test("private and contacts-only activities are enforced in the API response", async () => {
    const stranger = await getAccount(createDatabase(), outsider);
    assert.deepEqual(stranger.payload.habits, []);
    assert.equal(stranger.payload.privateRules.habits, "nobody");
    assert.equal(stranger.payload.privateRules.mail, "nobody");
    assert.equal(stranger.payload.acc.is_online, false);
    assert.equal(stranger.payload.acc.last_online, "2026-11-09T12:00:00Z");

    const contact = await getAccount(createDatabase(), friend);
    assert.equal(contact.payload.habits.length, 1);
    assert.equal(contact.payload.privateRules.habits, "all");

    const blockedContact = await getAccount(createDatabase({ blocked: true }), friend);
    assert.deepEqual(blockedContact.payload.habits, []);
    assert.equal(blockedContact.payload.privateRules.habits, "nobody");
    assert.equal(blockedContact.payload.acc.last_online, null);
    assert.equal(blockedContact.payload.acc.is_online, false);

    const self = await getAccount(createDatabase({ habitVisibility: "nobody" }), owner);
    assert.equal(self.payload.habits.length, 1);

    const publicHabits = await getAccount(createDatabase({ habitVisibility: "all" }), outsider);
    assert.equal(publicHabits.payload.habits.length, 1);
});

test("presence setting conceals last-seen and live status outside the permitted audience", async () => {
    const privatePresence = createDatabase({ presenceVisibility: "nobody" });
    assert.equal((await getAccount(privatePresence, outsider)).payload.acc.last_online, null);
    assert.equal((await getAccount(privatePresence, owner)).payload.acc.last_online, "2026-11-09T12:00:00Z");

    const contactsPresence = createDatabase({ presenceVisibility: "contacts" });
    assert.equal((await getAccount(contactsPresence, outsider)).payload.acc.last_online, null);
    assert.equal((await getAccount(contactsPresence, friend)).payload.acc.last_online, "2026-11-09T12:00:00Z");
});
