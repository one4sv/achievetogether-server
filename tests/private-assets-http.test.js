import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import privateAssetRoutes from "../routes/system/private-assets.js";

function fixture() {
    const publicUrl = (bucket, path) =>
        "https://example.supabase.co/storage/v1/object/public/" + bucket + "/" +
        path.split("/").map(encodeURIComponent).join("/");

    const ids = ["alice", "forwarded", "blocked", "hidden", "left", "outsider", "revoked"];
    const users = ids.map(id => ({ id, auth_version: 2, deletion_requested_at: null }));
    const now = new Date().toISOString();
    const sessions = ids.map(id => ({
        id: "session-" + id,
        user_id: id,
        revoked_at: id === "revoked" ? now : null,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        last_seen_at: now
    }));

    const forwards = Array.from({ length: 205 }, (_, index) => ({
        id: 100 + index,
        redirected_id: 12,
        chat_id: index === 204 ? "forwarded-chat" : "elsewhere",
        hidden: []
    }));

    const rows = {
        users,
        at_user_sessions: sessions,
        messages: [{ id: 12, chat_id: "original-chat", hidden: ["hidden"] }, ...forwards],
        message_files: [{
            id: 7,
            message_id: 12,
            file_name: "my photo.webp",
            file_type: "image/webp",
            file_url: publicUrl("media", "owner/my photo.webp")
        }],
        chat_members: [
            { user_id: "alice", chat_id: "original-chat", is_blocked: false },
            { user_id: "blocked", chat_id: "original-chat", is_blocked: true },
            { user_id: "hidden", chat_id: "original-chat", is_blocked: false },
            { user_id: "revoked", chat_id: "original-chat", is_blocked: false },
            { user_id: "forwarded", chat_id: "forwarded-chat", is_blocked: false }
        ],
        settings: [{
            user_id: "alice",
            bg_gallery: [{ path: "user_alice_bg_one.webp", url: publicUrl("bgs", "user_alice_bg_one.webp") }]
        }]
    };

    const supabase = {
        storage: {
            from: bucket => ({
                getPublicUrl: path => ({ data: { publicUrl: publicUrl(bucket, path) } }),
                download: async path => {
                    if (bucket === "media" && path === "owner/my photo.webp") {
                        return { data: new Blob(["abcdef"], { type: "image/webp" }), error: null };
                    }
                    if (bucket === "bgs" && path === "user_alice_bg_one.webp") {
                        return { data: new Blob(["wallpaper"], { type: "image/webp" }), error: null };
                    }
                    return { data: null, error: { message: "Not found" } };
                }
            })
        },
        from: table => {
            const filters = [];
            let orderBy = null;
            let ascending = true;
            const query = {
                select() { return query; },
                eq(key, value) { filters.push(row => row[key] === value); return query; },
                is(key, value) { filters.push(row => row[key] === value); return query; },
                gt(key, value) { filters.push(row => row[key] > value); return query; },
                order(key, options = {}) {
                    orderBy = key;
                    ascending = options.ascending !== false;
                    return query;
                },
                range(start, end) {
                    return Promise.resolve({ data: matching().slice(start, end + 1), error: null });
                },
                maybeSingle() {
                    return Promise.resolve({ data: matching()[0] || null, error: null });
                }
            };
            function matching() {
                const result = (rows[table] || []).filter(row => filters.every(filter => filter(row)));
                if (orderBy) result.sort((a, b) => {
                    if (a[orderBy] === b[orderBy]) return 0;
                    return (a[orderBy] < b[orderBy] ? -1 : 1) * (ascending ? 1 : -1);
                });
                return result;
            }
            return query;
        }
    };
    return supabase;
}

test("HTTP private assets enforce a live session and current membership", async t => {
    const priorSecret = process.env.JWT_SECRET;
    const priorUrl = process.env.SUPABASE_URL;
    process.env.JWT_SECRET = "test-only-private-asset-secret";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    t.after(() => {
        if (priorSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = priorSecret;
        if (priorUrl === undefined) delete process.env.SUPABASE_URL;
        else process.env.SUPABASE_URL = priorUrl;
    });

    const app = express();
    app.use(cookieParser());
    const routes = express.Router();
    privateAssetRoutes(routes, fixture());
    app.use("/api", routes);
    const server = createServer(app);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));

    const origin = "http://127.0.0.1:" + server.address().port;
    const mediaPath = "/api/private-asset/media/owner/my%20photo.webp";
    const bgPath = "/api/private-asset/bgs/user_alice_bg_one.webp";
    const cookie = (user, options = {}) => {
        if (!user) return "";
        if (user === "bad-signature") return "token=invalid";
        const token = jwt.sign({
            id: user,
            v: 2,
            sid: "session-" + user
        }, process.env.JWT_SECRET, { expiresIn: options.expired ? -10 : 600 });
        return "token=" + token;
    };
    const request = (path, user, extraHeaders = {}, options = {}) => fetch(origin + path, {
        headers: { ...extraHeaders, ...(user ? { cookie: cookie(user, options) } : {}) }
    });

    for (const user of [null, "bad-signature", "revoked"]) {
        const res = await request(mediaPath, user);
        assert.equal(res.status, 401, "Media must reject missing, invalid or revoked session");
        assert.equal(res.headers.get("cache-control"), "private, no-store");
    }

    const expired = await request(mediaPath, "alice", {}, { expired: true });
    assert.equal(expired.status, 401, "Expired JWT must not authorize a download");

    for (const user of ["blocked", "hidden", "left", "outsider"]) {
        const res = await request(mediaPath, user);
        assert.equal(res.status, 403, "Media must reject user " + user);
    }

    const owner = await request(mediaPath, "alice");
    assert.equal(owner.status, 200);
    assert.equal(owner.headers.get("cache-control"), "private, no-store");
    assert.equal(owner.headers.get("x-content-type-options"), "nosniff");
    assert.equal(owner.headers.get("content-type"), "image/webp");
    assert.equal(await owner.text(), "abcdef");

    // The visible forward is after the 200th item; a fixed .limit(200) incorrectly denied it.
    const forwarded = await request(mediaPath, "forwarded");
    assert.equal(forwarded.status, 200);
    assert.equal(await forwarded.text(), "abcdef");

    const ranged = await request(mediaPath, "alice", { range: "bytes=2-4" });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), "bytes 2-4/6");
    assert.equal(await ranged.text(), "cde");

    const invalidRange = await request(mediaPath, "alice", { range: "bytes=99-100" });
    assert.equal(invalidRange.status, 416);

    const missing = await request("/api/private-asset/media/owner/absent.webp", "alice");
    assert.equal(missing.status, 403);

    const background = await request(bgPath, "alice");
    assert.equal(background.status, 200);
    assert.equal(await background.text(), "wallpaper");

    const foreignBg = await request(bgPath, "forwarded");
    assert.equal(foreignBg.status, 403);
    const anonymousBg = await request(bgPath, null);
    assert.equal(anonymousBg.status, 401);
});
