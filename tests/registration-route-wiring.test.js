import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import createApp from "../app.js";

test("registration and availability routes are mounted in the server", async () => {
    const queries = [];
    const supabase = {
        from(table) {
            queries.push(table);
            return {
                select() { return this; },
                eq() { return this; },
                async limit() { return { data: [], error: null }; }
            };
        }
    };
    const server = createServer(createApp(supabase));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const status = await fetch(`${base}/register`);
        assert.equal(status.status, 200);
        assert.equal(await status.text(), "Принимаем...");

        const check = await fetch(`${base}/register/check`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ nick: "availableNick" })
        });
        assert.equal(check.status, 200);
        assert.deepEqual(await check.json(), { success: true });
        assert.deepEqual(queries, ["users", "pending_users"]);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
