import test from "node:test";
import assert from "node:assert/strict";
import { privateAssetUrl, originalAssetUrl, rewritePrivateAssets, canDownloadMedia, canDownloadBackground } from "../routes/system/private-assets.js";

test("asset URL rewrite only applies to own Supabase media and bgs", () => {
    const previous = process.env.SUPABASE_URL;
    process.env.SUPABASE_URL = "https://example.supabase.co";
    try {
        assert.equal(privateAssetUrl("https://example.supabase.co/storage/v1/object/public/media/a/file.webp"),
            "/api/private-asset/media/a/file.webp");
        assert.equal(privateAssetUrl("https://another.example/storage/v1/object/public/media/a/file.webp"),
            "https://another.example/storage/v1/object/public/media/a/file.webp");
        assert.equal(privateAssetUrl("https://example.supabase.co/storage/v1/object/public/avatars/a.webp"),
            "https://example.supabase.co/storage/v1/object/public/avatars/a.webp");
        const mocked = { storage: { from: () => ({ getPublicUrl: path => ({ data: { publicUrl: "https://example.supabase.co/storage/v1/object/public/media/" + path } }) }) } };
        assert.equal(originalAssetUrl("/api/private-asset/media/a/file.webp", mocked),
            "https://example.supabase.co/storage/v1/object/public/media/a/file.webp");
        assert.equal(originalAssetUrl("/api/private-asset/media/a/my%20photo.webp", mocked),
            "https://example.supabase.co/storage/v1/object/public/media/a/my photo.webp");
        assert.equal(originalAssetUrl("/api/private-asset/media/a/../secret.webp", mocked),
            "/api/private-asset/media/a/../secret.webp");
        assert.deepEqual(rewritePrivateAssets({ files: [{ url: "https://example.supabase.co/storage/v1/object/public/media/a/file.webp" }] }),
            { files: [{ url: "/api/private-asset/media/a/file.webp" }] });
    } finally {
        if (previous === undefined) delete process.env.SUPABASE_URL;
        else process.env.SUPABASE_URL = previous;
    }
});

function fakeSupabase({ blocked = false, hidden = false, forwarded = false, hasMembership = true } = {}) {
    const originals = [{ id: 12, chat_id: "private-a", hidden: hidden ? ["alice"] : [] }];
    const forwards = forwarded ? [{ id: 13, chat_id: "private-b", hidden: [], redirected_id: 12 }] : [];
    const members = hasMembership ? [
        { chat_id: forwarded ? "private-b" : "private-a", user_id: "alice", is_blocked: blocked }
    ] : [];
    const tables = {
        message_files: [{ id: 7, message_id: 12, file_url: "https://example.supabase.co/storage/v1/object/public/media/owner/file.jpg", file_type: "image/jpeg" }],
        messages: [...originals, ...forwards],
        chat_members: members,
        settings: [{ user_id: "alice", bg_gallery: [{ path: "user_alice_bg_1.webp" }] }]
    };
    return {
        storage: { from: bucket => ({ getPublicUrl: path => ({ data: { publicUrl: "https://example.supabase.co/storage/v1/object/public/" + bucket + "/" + path } }) }) },
        from: table => {
            let filters = [];
            const query = {
                select() { return query; },
                eq(key, value) { filters.push(row => row[key] === value); return query; },
                limit() { return Promise.resolve({ data: tables[table].filter(row => filters.every(f => f(row))), error: null }); },
                order() { return query; },
                range(start, end) { return Promise.resolve({ data: tables[table].filter(row => filters.every(f => f(row))).slice(start, end + 1), error: null }); },
                maybeSingle() { return Promise.resolve({ data: tables[table].find(row => filters.every(f => f(row))) || null, error: null }); }
            };
            return query;
        }
    };
}

test("private media requires membership and rejects blocked or hidden source", async () => {
    assert.ok(await canDownloadMedia(fakeSupabase(), "owner/file.jpg", "alice"));
    assert.equal(await canDownloadMedia(fakeSupabase({ hasMembership: false }), "owner/file.jpg", "alice"), null);
    assert.equal(await canDownloadMedia(fakeSupabase({ blocked: true }), "owner/file.jpg", "alice"), null);
    assert.equal(await canDownloadMedia(fakeSupabase({ hidden: true }), "owner/file.jpg", "alice"), null);
    assert.equal(await canDownloadMedia(fakeSupabase(), "owner/other.jpg", "alice"), null);
});

test("forwarded media is accessible through a visible authorized copy only", async () => {
    assert.ok(await canDownloadMedia(fakeSupabase({ forwarded: true }), "owner/file.jpg", "alice"));
    assert.equal(await canDownloadMedia(fakeSupabase({ forwarded: true, blocked: true }), "owner/file.jpg", "alice"), null);
});

test("custom wallpaper download is only allowed for its owner", async () => {
    assert.ok(await canDownloadBackground(fakeSupabase(), "user_alice_bg_1.webp", "alice"));
    assert.equal(await canDownloadBackground(fakeSupabase(), "user_bob_bg_1.webp", "alice"), null);
    assert.ok(await canDownloadBackground(fakeSupabase(), "user_alice_legacy.webp", "alice"));
    assert.equal(await canDownloadBackground(fakeSupabase(), "user_bob_legacy.webp", "alice"), null);
});
