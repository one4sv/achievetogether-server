import test from "node:test";
import assert from "node:assert/strict";
import { sendMail } from "../services/sendmail.js";

const originalFetch = globalThis.fetch;
const saved = {
    BREVO_API_KEY: process.env.BREVO_API_KEY,
    BREVO_SENDER_EMAIL: process.env.BREVO_SENDER_EMAIL,
    MAIL_FROM: process.env.MAIL_FROM,
    MAIL_FROM_NAME: process.env.MAIL_FROM_NAME
};

function setup() {
    process.env.BREVO_API_KEY = "fake-test-key";
    process.env.BREVO_SENDER_EMAIL = "verified@example.com";
    process.env.MAIL_FROM_NAME = "AchieveTogether";
    delete process.env.MAIL_FROM;
}
function restore() {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

test("Brevo API sends the correct request with the configured sender", async () => {
    setup();
    try {
        let actual;
        globalThis.fetch = async (url, options) => {
            actual = { url, options };
            return { ok: true, status: 201 };
        };
        await sendMail("test@example.org", "Registration", "<p>AT</p>");
        assert.equal(actual.url, "https://api.brevo.com/v3/smtp/email");
        assert.equal(actual.options.headers["api-key"], "fake-test-key");
        assert.equal(actual.options.method, "POST");
        assert.deepEqual(JSON.parse(actual.options.body), {
            sender: { name: "AchieveTogether", email: "verified@example.com" },
            to: [{ email: "test@example.org" }],
            subject: "Registration",
            htmlContent: "<p>AT</p>"
        });
    } finally {
        restore();
    }
});

test("Brevo failure is reported without silently switching providers", async () => {
    setup();
    try {
        globalThis.fetch = async () => ({ ok: false, status: 401 });
        await assert.rejects(sendMail("test@example.org", "Test", "<p>AT</p>"), /Brevo email delivery failed/);
    } finally {
        restore();
    }
});

test("Brevo sender must be configured", async () => {
    setup();
    try {
        delete process.env.BREVO_SENDER_EMAIL;
        await assert.rejects(sendMail("test@example.org", "Test", "<p>AT</p>"), /sender is not configured/);
    } finally {
        restore();
    }
});
