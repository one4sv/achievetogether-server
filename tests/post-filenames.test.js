import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUploadFileName } from "../utils/savePost.js";
import { signedMedia } from "../utils/postContent.js";

test("correctly restores a Cyrillic PDF name received through Latin-1 multipart headers", () => {
    const name = "Тестовый файл.pdf";
    const encodedAsLatin1 = Buffer.from(name, "utf8").toString("latin1");

    assert.equal(normalizeUploadFileName(encodedAsLatin1), name);
    assert.equal(normalizeUploadFileName(name), name);
});

test("preserves already valid file names", () => {
    assert.equal(normalizeUploadFileName("document.pdf"), "document.pdf");
    assert.equal(normalizeUploadFileName("résumé.pdf"), "résumé.pdf");
    assert.equal(normalizeUploadFileName("Ð-document.pdf"), "Ð-document.pdf");
});

test("already stored mojibake PDF names are normalized in all post API responses", async () => {
    const name = "Олимпиада Я - профессионал.pdf";
    const saved = Buffer.from(name, "utf8").toString("latin1");
    const media = await signedMedia({}, [{ id: "old", name: saved, type: "application/pdf", url: "" }], "posts", 3);
    assert.equal(media[0].name, name);
});

test("post and comment media never include Supabase signed URLs", () => {
    const source = { id: "original", name: "photo.jpg", type: "image/jpeg",
        url: "https://example.supabase.co/storage/v1/object/public/posts/owner/3/photo.jpg" };
    const [post] = signedMedia({}, [source], "posts", 3);
    assert.equal(post.id, source.id);
    assert.equal(post.url, "/api/post-asset/3/0");
    const [shared] = signedMedia({}, [source], "posts", 3, "33333333-3333-4333-8333-333333333333");
    assert.equal(shared.url, "/api/post-asset/3/0?share=33333333-3333-4333-8333-333333333333");
    const [comment] = signedMedia({}, [source], "comments", 8);
    assert.equal(comment.url, "/api/comment-asset/8/0");
    assert.throws(() => signedMedia({}, [source], "posts"), /valid resource owner/);
});
