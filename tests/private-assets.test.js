import test from "node:test";
import assert from "node:assert/strict";
import { privateAssetUrl, originalAssetUrl, rewritePrivateAssets } from "../routes/system/private-assets.js";

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
        assert.deepEqual(rewritePrivateAssets({ files: [{ url: "https://example.supabase.co/storage/v1/object/public/media/a/file.webp" }] }),
            { files: [{ url: "/api/private-asset/media/a/file.webp" }] });
    } finally {
        if (previous === undefined) delete process.env.SUPABASE_URL;
        else process.env.SUPABASE_URL = previous;
    }
});
