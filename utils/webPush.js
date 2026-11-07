import { createECDH, createHash, createPrivateKey, createCipheriv, hkdfSync, randomBytes, sign } from "node:crypto";

const allowedHosts = hostname =>
    hostname === "fcm.googleapis.com" ||
    hostname === "updates.push.services.mozilla.com" ||
    hostname === "push.services.mozilla.com" ||
    hostname === "web.push.apple.com" ||
    hostname.endsWith(".push.apple.com") ||
    hostname.endsWith(".notify.windows.com");

export function validPushEndpoint(endpoint) {
    if (typeof endpoint !== "string" || endpoint.length > 2048) return false;
    try {
        const url = new URL(endpoint);
        return url.protocol === "https:" && !url.username && !url.password &&
            (!url.port || url.port === "443") && allowedHosts(url.hostname.toLowerCase());
    } catch {
        return false;
    }
}

export const endpointHash = endpoint => createHash("sha256").update(endpoint).digest("hex");

const decode = value => Buffer.from(value, "base64url");
const encode = value => Buffer.from(value).toString("base64url");
const keyPair = () => {
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    if (!privateKey || !publicKey || !/^mailto:[^\s@]+@[^\s@]+$/.test(process.env.VAPID_SUBJECT || "")) return null;
    try {
        const secret = decode(privateKey);
        const publicBytes = decode(publicKey);
        if (secret.length !== 32 || publicBytes.length !== 65 || publicBytes[0] !== 4) return null;
        const ecdh = createECDH("prime256v1");
        ecdh.setPrivateKey(secret);
        if (!ecdh.getPublicKey().equals(publicBytes)) return null;
        return { secret, publicBytes, publicKey };
    } catch {
        return null;
    }
};

export function publicVapidKey() {
    return keyPair()?.publicKey ?? null;
}

export function validPushSubscription(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        !validPushEndpoint(value.endpoint) || !value.keys ||
        typeof value.keys.p256dh !== "string" || typeof value.keys.auth !== "string") return false;
    try {
        const publicKey = decode(value.keys.p256dh);
        const auth = decode(value.keys.auth);
        if (publicKey.length !== 65 || publicKey[0] !== 4 || auth.length !== 16) return false;
        const ecdh = createECDH("prime256v1");
        ecdh.generateKeys();
        ecdh.computeSecret(publicKey);
        return value.expirationTime == null ||
            (Number.isSafeInteger(value.expirationTime) && value.expirationTime > Date.now());
    } catch {
        return false;
    }
}

function vapidToken(endpoint, keys) {
    const now = Math.floor(Date.now() / 1000);
    const header = encode(JSON.stringify({ typ: "JWT", alg: "ES256" }));
    const payload = encode(JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: now + 12 * 60 * 60,
        sub: process.env.VAPID_SUBJECT
    }));
    const privateKey = createPrivateKey({
        key: {
            kty: "EC", crv: "P-256", d: encode(keys.secret),
            x: encode(keys.publicBytes.subarray(1, 33)),
            y: encode(keys.publicBytes.subarray(33))
        },
        format: "jwk"
    });
    const input = header + "." + payload;
    return input + "." + encode(sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }));
}

// RFC 8291 / RFC 8188 aes128gcm content encryption (single final record).
export function encryptPushPayload(subscription, payload) {
    if (!validPushSubscription(subscription)) throw new Error("Invalid push subscription");
    const receiverPublic = decode(subscription.keys.p256dh);
    const receiverAuth = decode(subscription.keys.auth);
    const sender = createECDH("prime256v1");
    sender.generateKeys();
    const senderPublic = sender.getPublicKey();
    const secret = sender.computeSecret(receiverPublic);
    const context = Buffer.concat([Buffer.from("WebPush: info\0"), receiverPublic, senderPublic]);
    const ikm = hkdfSync("sha256", secret, receiverAuth, context, 32);
    const salt = randomBytes(16);
    const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
    const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
    const plaintext = Buffer.concat([Buffer.from(JSON.stringify(payload), "utf8"), Buffer.from([2])]);
    if (plaintext.length > 3900) throw new Error("Push notification too large");
    const cipher = createCipheriv("aes-128-gcm", cek, nonce);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    const recordSize = Buffer.alloc(4);
    recordSize.writeUInt32BE(4096);
    return Buffer.concat([salt, recordSize, Buffer.from([senderPublic.length]), senderPublic, encrypted]);
}

export async function sendWebPush(subscription, payload, fetcher = fetch) {
    const keys = keyPair();
    if (!keys) return { delivered: false, status: 503 };
    if (!validPushSubscription(subscription)) return { delivered: false, status: 400 };
    const body = encryptPushPayload(subscription, payload);
    const response = await fetcher(subscription.endpoint, {
        method: "POST",
        headers: {
            Authorization: "vapid t=" + vapidToken(subscription.endpoint, keys) + ", k=" + keys.publicKey,
            "Content-Type": "application/octet-stream",
            "Content-Encoding": "aes128gcm",
            "Content-Length": String(body.length),
            TTL: "3600",
            Urgency: "normal"
        },
        body,
        signal: AbortSignal.timeout(8000),
        redirect: "error"
    });
    return { delivered: response.ok, status: response.status };
}
