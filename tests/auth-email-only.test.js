import assert from "node:assert/strict";
import test from "node:test";
import registerAuthRoutes from "../routes/auth/auth.js";

const setup = () => {
    let authHandler;
    const queries = [];
    const app = {
        post(path, handler) {
            if (path === "/auth") authHandler = handler;
        }
    };
    const supabase = {
        from(table) {
            queries.push({ table });
            return {
                select() { return this; },
                eq(field, value) {
                    queries.at(-1).field = field;
                    queries.at(-1).value = value;
                    return this;
                },
                async maybeSingle() { return { data: null, error: null }; }
            };
        }
    };
    registerAuthRoutes(app, supabase);
    const request = async (login) => {
        let status = 200;
        let body = null;
        const res = {
            status(value) { status = value; return this; },
            json(value) { body = value; return this; }
        };
        await authHandler({ body: { login, pass: "TestPassword123" } }, res);
        return { status, body };
    };
    return { request, queries };
};

test("login by nickname is rejected without looking up user", async () => {
    const { request, queries } = setup();
    const result = await request("nickname123");
    assert.equal(result.status, 400);
    assert.equal(result.body.success, false);
    assert.equal(queries.length, 0);
});

test("email is normalized and the only database lookup key", async () => {
    const { request, queries } = setup();
    const result = await request("  Example@Example.COM  ");
    assert.equal(result.status, 401);
    assert.deepEqual(queries, [{ table: "users", field: "mail", value: "example@example.com" }]);
});

test("invalid email format does not query the database", async () => {
    const { request, queries } = setup();
    const result = await request("not-an-email@");
    assert.equal(result.status, 400);
    assert.equal(queries.length, 0);
});
