import test from "node:test";
import assert from "node:assert/strict";
import { sendMail } from "../services/sendmail.js";

const keys = ["RESEND_API_KEY", "RESEND_FROM_EMAIL", "MAIL_FROM", "MAIL_FROM_NAME"];
const originals = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const realFetch = globalThis.fetch;

const prepare = () => {
    process.env.RESEND_API_KEY = "re_fake_test_key";
    process.env.RESEND_FROM_EMAIL = "noreply@example.com";
    process.env.MAIL_FROM_NAME = "AchieveTogether";
    delete process.env.MAIL_FROM;
};
const restore = () => {
    globalThis.fetch = realFetch;
    for (const key of keys) {
        if (originals[key] === undefined) delete process.env[key];
        else process.env[key] = originals[key];
    }
};

test("Resend calls the email API with the configured sender", async () => {
    prepare();
    try {
        let request;
        globalThis.fetch = async (url, options) => {
            request = { url, options };
            return { ok: true, status: 200 };
        };
        await sendMail("recipient@example.net", "Registration", "<p>Code</p>");
        assert.equal(request.url, "https://api.resend.com/emails");
        assert.equal(request.options.method, "POST");
        assert.equal(request.options.headers.Authorization, "Bearer re_fake_test_key");
        assert.equal(request.options.headers["Content-Type"], "application/json");
        assert.deepEqual(JSON.parse(request.options.body), {
            from: "AchieveTogether <noreply@example.com>",
            to: ["recipient@example.net"],
            subject: "Registration",
            html: "<p>Code</p>"
        });
    } finally {
        restore();
    }
});

test("Resend HTTP errors surface instead of silently falling back", async () => {
    prepare();
    try {
        globalThis.fetch = async () => ({ ok: false, status: 403 });
        await assert.rejects(sendMail("recipient@example.net", "Test", "<p>Test</p>"),
            /Resend email request failed/);
    } finally {
        restore();
    }
});

test("Resend requires an explicit sender", async () => {
    prepare();
    try {
        delete process.env.RESEND_FROM_EMAIL;
        await assert.rejects(sendMail("recipient@example.net", "Test", "<p>Test</p>"),
            /Resend sender email is not configured/);
    } finally {
        restore();
    }
});
