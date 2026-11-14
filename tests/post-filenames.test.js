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
    const media = await signedMedia({}, [{ id: "old", name: saved, type: "application/pdf", url: "" }], "posts");
    assert.equal(media[0].name, name);
});
