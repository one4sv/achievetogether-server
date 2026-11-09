import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUploadFileName } from "../utils/savePost.js";

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
