import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import initWebSocket, { broadcastReaction, broadcastMessageDeleted } from "../realtime/ws.js";

test("real websocket connections isolate chat events and reject malformed/group-spoofed input", { timeout: 10000 }, async () => {
    const users = ["owner", "member", "outsider", "blocked"];
    const tickets = users.map((user_id, i) => ({ user_id, session_id: null, auth_version: 1,
        token_hash: createHash("sha256").update(String(i).repeat(43)).digest("hex") }));
    const members = users.filter(id => id !== "outsider").map(user_id => ({
        user_id, chat_id: 10, is_blocked: user_id === "blocked"
    }));
    const db = { from(table) {
        let filters = [], single = false, deletion = false;
        const query = {
            select() { return query; }, update() { return query; }, gt() { return query; },
            delete() { deletion = true; return query; },
            eq(key, value) { filters.push(row => row[key] === value); return query; },
            single() { single = true; return query; }, maybeSingle() { single = true; return query; },
            then(resolve, reject) {
                const source = table === "at_ws_tickets" ? tickets : table === "chat_members" ? members :
                    users.map(id => ({ id, nick: id, auth_version: 1 }));
                const rows = source.filter(row => filters.every(filter => filter(row)));
                if (deletion) rows.forEach(row => source.splice(source.indexOf(row), 1));
                return Promise.resolve({ data: single ? rows[0] : rows, error: null }).then(resolve, reject);
            }
        };
        return query;
    } };
    const server = createServer();
    const wss = initWebSocket(db, server);
    const sockets = [];
    const inboxes = users.map(() => []);
    try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        for (let i = 0; i < users.length; i++) {
            const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws?ticket=${String(i).repeat(43)}`,
                { origin: "https://achievetogether.vercel.app" });
            sockets.push(socket);
            socket.on("message", raw => inboxes[i].push(JSON.parse(raw)));
            await once(socket, "open");
        }
        await delay(30);
        inboxes.forEach(inbox => inbox.splice(0));
        await broadcastReaction(10, { messageId: 1, user_id: "owner", reaction: "👍", removed: false });
        await broadcastMessageDeleted(10, 1, "member");
        sockets[2].send(JSON.stringify({ type: "TYPING", to: 10, is_group: true }));
        sockets[0].send("{broken");
        sockets[0].send("null");
        sockets[0].send(JSON.stringify({ type: "TYPING", to: 10, is_group: true, secret: "do not forward" }));
        await delay(80);
        assert.deepEqual(inboxes[2], []);
        assert.deepEqual(inboxes[3], []);
        assert.equal(inboxes[0].filter(event => event.type === "MESSAGE_REACTION").length, 1);
        assert.equal(inboxes[0].filter(event => event.type === "MESSAGE_DELETED").length, 0);
        assert.equal(inboxes[1].filter(event => event.type === "MESSAGE_DELETED").length, 1);
        const typing = inboxes[1].filter(event => event.type === "TYPING");
        assert.equal(typing.length, 1);
        assert.equal(typing[0].from, "owner");
        assert.equal(typing[0].secret, undefined);
        assert.equal(sockets[0].readyState, WebSocket.OPEN);
    } finally {
        const closed = sockets.map(socket => socket.readyState === WebSocket.CLOSED ? Promise.resolve() : once(socket, "close"));
        sockets.forEach(socket => socket.close());
        await Promise.all(closed);
        await new Promise(resolve => wss.close(resolve));
        await new Promise(resolve => server.close(resolve));
    }
});
