import test from "node:test";
import assert from "node:assert/strict";
import { makeEmail, cleanUrl } from "../routes/system/feedback.js";

test("feedback mail escapes HTML from all user-controlled fields", () => {
    const malicious = '<img src=x onerror=alert(1)>';
    const result = makeEmail({
        id: "T-1",
        kind: "complaint",
        reason: "spam",
        title: malicious,
        details: malicious,
        target: malicious,
        sender: malicious,
        page: malicious,
        created: "UTC"
    });
    assert.ok(!result.includes(malicious));
    assert.ok(result.includes("&lt;img"));
    assert.ok(result.includes("Спам"));
    assert.ok(result.includes("AchieveTogether"));
});

test("feedback never trusts external target links", () => {
    assert.equal(cleanUrl("/post/10#comment-3"), "/post/10");
    assert.equal(cleanUrl("/chat/nick?token=abc"), "/chat/nick");
    assert.equal(cleanUrl("https://evil.example/path"), null);
    assert.equal(cleanUrl("//evil.example/path"), null);
    assert.equal(cleanUrl(null), null);
});
