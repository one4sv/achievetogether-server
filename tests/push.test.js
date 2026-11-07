import test from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { encryptPushPayload, endpointHash, validPushEndpoint, validPushSubscription, sendWebPush, publicVapidKey } from "../utils/webPush.js";

const receiver = createECDH("prime256v1");
receiver.generateKeys();
const sub = {
    endpoint: "https://fcm.googleapis.com/fcm/send/test",
    keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url") }
};

test("rejects non-standard and internal push URLs", () => {
    for (const url of ["http://fcm.googleapis.com/test", "https://127.0.0.1/a", "https://example.com/", "https://fcm.googleapis.com.evil.test/", "https://localhost/", "https://fcm.googleapis.com:444/"]) {
        assert.equal(validPushEndpoint(url), false);
    }
    assert.equal(validPushSubscription(sub), true);
    assert.equal(validPushSubscription({ ...sub, keys: { ...sub.keys, auth: "no" } }), false);
    assert.equal(endpointHash(sub.endpoint).length, 64);
});

test("aes128gcm payload decrypts according to RFC 8291", () => {
    const payload = { title: "hello", body: "world", url: "/chat/g/1" };
    const record = encryptPushPayload(sub, payload);
    const salt = record.subarray(0, 16);
    assert.equal(record.readUInt32BE(16), 4096);
    assert.equal(record[20], 65);
    const sender = record.subarray(21, 86);
    const shared = receiver.computeSecret(sender);
    const context = Buffer.concat([Buffer.from("WebPush: info\0"), receiver.getPublicKey(), sender]);
    const ikm = hkdfSync("sha256", shared, Buffer.alloc(16, 7), context, 32);
    const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
    const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
    const ciphertext = record.subarray(86);
    const decipher = createDecipheriv("aes-128-gcm", key, nonce);
    decipher.setAuthTag(ciphertext.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    assert.equal(plaintext.at(-1), 2);
    assert.deepEqual(JSON.parse(plaintext.subarray(0, -1).toString()), payload);
});

test("sender stays disabled without configured VAPID keys", async () => {
    const original = [process.env.VAPID_PRIVATE_KEY, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_SUBJECT];
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_SUBJECT;
    try {
        assert.equal(publicVapidKey(), null);
        const result = await sendWebPush(sub, {}, () => { throw new Error("Must not send"); });
        assert.equal(result.status, 503);
    } finally {
        [process.env.VAPID_PRIVATE_KEY, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_SUBJECT] = original;
    }
});
