import assert from "node:assert/strict";
import test from "node:test";
import registerRoutes from "../routes/auth/register.js";

function setup({ secondsAgo = 70, hasPending = true, failedDelivery = false } = {}) {
    const stored = hasPending ? {
        id: 12, nick: "availableNick", mail: "example@example.com", code: "123456",
        created_at: new Date(Date.now() - secondsAgo * 1000).toISOString(),
        expires_at: new Date(Date.now() + 60000).toISOString()
    } : null;
    const original = stored && { ...stored };
    const messages = [];
    const handlers = new Map();
    const app = { post(path, handler) { handlers.set(path, handler); }, get() {} };
    const supabase = {
        from(table) {
            assert.equal(table, "pending_users");
            let predicates = [];
            let updatedFields = null;
            const query = {
                select() { return query; },
                eq(column, value) { predicates.push(row => row[column] === value); return query; },
                lte(column, value) { predicates.push(row => row[column] <= value); return query; },
                update(fields) { updatedFields = fields; return query; },
                async maybeSingle() {
                    if (!stored || !predicates.every(predicate => predicate(stored))) return { data: null, error: null };
                    if (updatedFields) Object.assign(stored, updatedFields);
                    return { data: updatedFields ? { id: stored.id } : { ...stored }, error: null };
                },
                then(resolve, reject) {
                    if (updatedFields && stored && predicates.every(predicate => predicate(stored)))
                        Object.assign(stored, updatedFields);
                    return Promise.resolve({ error: null }).then(resolve, reject);
                }
            };
            return query;
        }
    };
    registerRoutes(app, supabase, { send: async (mail, subject, html) => {
        messages.push({ mail, subject, html });
        if (failedDelivery) throw new Error("mail unavailable");
    } });
    async function request(mail = "Example@Example.COM") {
        let code = 200;
        let body;
        let retryAfter = null;
        const res = {
            set(name, value) { if (name === "Retry-After") retryAfter = value; return res; },
            status(value) { code = value; return res; },
            json(value) { body = value; return res; }
        };
        await handlers.get("/register/resend")({ body: { mail } }, res);
        return { code, body, retryAfter };
    }
    return { request, stored, original, messages, handlers };
}

test("resend rejects attempts before the one-minute cooldown expires", async () => {
    const context = setup({ secondsAgo: 25 });
    const result = await context.request();
    assert.equal(result.code, 429);
    assert.ok(result.body.retryAfterSeconds >= 34 && result.body.retryAfterSeconds <= 36);
    assert.equal(result.retryAfter, String(result.body.retryAfterSeconds));
    assert.equal(context.stored.code, context.original.code);
    assert.equal(context.messages.length, 0);
});

test("resend creates a new code and renews expiry only after cooldown", async () => {
    const context = setup();
    const result = await context.request();
    assert.equal(result.code, 200);
    assert.deepEqual(result.body, { success: true, retryAfterSeconds: 60 });
    assert.notEqual(context.stored.code, context.original.code);
    assert.equal(context.messages.length, 1);
    assert.equal(context.messages[0].mail, "example@example.com");
    assert.match(context.messages[0].html, new RegExp(context.stored.code));
    assert.ok(new Date(context.stored.expires_at) > new Date(context.original.expires_at));
    const second = await context.request();
    assert.equal(second.code, 429);
    assert.equal(context.messages.length, 1);
});

test("mail delivery errors restore the old code and resend timestamp", async () => {
    const context = setup({ failedDelivery: true });
    const result = await context.request();
    assert.equal(result.code, 500);
    assert.equal(result.body.success, false);
    assert.deepEqual(context.stored, context.original);
});

test("resend never sends a message for a nonexistent pending account", async () => {
    const context = setup({ hasPending: false });
    const result = await context.request();
    assert.equal(result.code, 404);
    assert.equal(context.messages.length, 0);
});
