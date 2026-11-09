import { WebSocketServer, WebSocket } from "ws";
import { createHash } from "node:crypto";
import { deliverMessagePush } from "../services/push.js";
import { rewritePrivateAssets } from "../routes/system/private-assets.js";
let clientsMap = new Map();
let supabaseGlobal;
let broadcastUserStatus;

// A profile lookup reads this on demand; realtime status events remain limited to shared chats.
export function isUserOnline(userId) {
  const sockets = clientsMap.get(userId);
  return !!sockets && [...sockets].some(socket => socket.readyState === WebSocket.OPEN);
}

// Presence is private conversation metadata, never a broadcast to all signed-in users.
export async function canSeePresence(supabase, viewerId, subjectId) {
  if (!viewerId || !subjectId) return false;
  if (viewerId === subjectId) return true;
  const { data: memberships, error } = await supabase.from("chat_members")
    .select("chat_id,is_blocked").eq("user_id", viewerId);
  if (error || !memberships) return false;
  const ids = memberships.filter(member => !member.is_blocked).map(member => member.chat_id);
  if (!ids.length) return false;
  const { data: shared, error: sharedError } = await supabase.from("chat_members")
    .select("chat_id,is_blocked").eq("user_id", subjectId).in("chat_id", ids);
  return !sharedError && !!shared?.some(member => !member.is_blocked);
}

export function disconnectAuthSession(sessionId) {
  for (const sockets of clientsMap.values()) sockets.forEach(ws => {
    if (ws.authSessionId === sessionId && ws.readyState === WebSocket.OPEN) ws.close(1008, "Session revoked");
  });
}

export function disconnectUserSockets(userId) {
  clientsMap.get(userId)?.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.close(1008, "Session revoked");
  });
}

export async function broadcastNewMessage(chat_id, message) {
  try {
    const senderId = message.sender_id;
    const { data: senderData } = await supabaseGlobal
      .from("users")
      .select("nick, username")
      .eq("id", senderId)
      .single();

    const { data: members } = await supabaseGlobal
      .from("chat_members")
      .select("user_id, note, is_blocked")
      .eq("chat_id", chat_id);

    if (!members || members.length === 0) {
      console.warn(`No members found for chat_id: ${chat_id}. Skipping broadcast.`);
      return;
    }

    const { data: chat } = await supabaseGlobal
      .from("chats")
      .select("name, is_group")
      .eq("id", chat_id)
      .single();

    if (!chat) {
      console.warn(`Chat not found for chat_id: ${chat_id}. Skipping broadcast.`);
      return;
    }

    const userIds = members.map(m => m.user_id);
    const { data: settingsList } = await supabaseGlobal
      .from("settings")
      .select("user_id, all_note, new_mess_note")
      .in("user_id", userIds);

    const settingsMap = new Map(settingsList?.map(s => [s.user_id, s]) || []);

    for (const member of members) {
      const userId = member.user_id;
      const userSettings = settingsMap.get(userId);
      const allNote = userSettings?.all_note ?? true;
      const newMessNote = userSettings?.new_mess_note ?? true;
      const chatNote = member.note ?? true;
      console.log("UserId:", userId, "allNote:", allNote, "newMessNote:", newMessNote, "chatNote:", chatNote);
     
      if (member.is_blocked) continue;
      if (userId !== senderId && allNote && newMessNote && chatNote) {
        void deliverMessagePush(supabaseGlobal, {
          userId, senderId, senderName: senderData?.username,
          senderNick: senderData?.nick, chatId: chat_id,
          chatName: chat.name, isGroup: chat.is_group, message
        }).catch(error => console.warn("Push dispatch failed:", error.message));
      }
      if ((allNote && newMessNote && chatNote) || message.habit_invite_habit_id) {
        const sockets = clientsMap.get(userId);
        sockets?.forEach(s => {
          if (s.readyState === WebSocket.OPEN) {
            s.send(JSON.stringify({
              type: "NEW_MESSAGE",
              chat_id: chat_id,
              chat_name: chat?.name || undefined,
              message: rewritePrivateAssets(message),
              nick: senderData?.nick || null,
              username: senderData?.username || null,
              is_note: allNote && newMessNote && chatNote,
              is_group: chat.is_group
            }));
          }
        });
      }
    }
  } catch (err) {
    console.error("Ошибка в broadcastNewMessage:", err);
  }
}

export async function broadcastHabitCommentUpdated(supabase, habitId, date) {
  try {
    const { data: habit, error } = await supabase.from("habits").select("user_id").eq("id", habitId).single();
    if (error) throw error;
    const { data: members, error: membersError } = await supabase.from("habit_members")
      .select("user_id").eq("habit_id", habitId).eq("status", "accepted");
    if (membersError) throw membersError;
    const ids = new Set([habit.user_id, ...(members || []).map(member => member.user_id)]);
    for (const id of ids) {
      clientsMap.get(id)?.forEach(socket => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "HABIT_DAY_COMMENT_UPDATED", habitId: Number(habitId), date }));
      });
    }
  } catch (error) {
    console.error("Ошибка обновления комментариев активности:", error);
  }
}

export function broadcastMessageEdited(chat_id, message, eventType = "MESSAGE_EDITED") {
  supabaseGlobal
    .from("chat_members")
    .select("user_id,is_blocked")
    .eq("chat_id", chat_id)
    .then(({ data: members }) => {
      members?.forEach(member => {
        if (member.is_blocked) return;
        const sockets = clientsMap.get(member.user_id);
        sockets?.forEach(s => {
          if (s.readyState === WebSocket.OPEN) {
            s.send(JSON.stringify({
              type: eventType,
              chatId: chat_id,
              message: rewritePrivateAssets(message)
            }));
          }
        });
      });
    })
    .catch(err => console.error("Ошибка в broadcastMessageEdited:", err));
}
export function broadcastMessageRead(chat_id, messageId, userId) {
  supabaseGlobal
    .from("chat_members")
    .select("user_id,is_blocked")
    .eq("chat_id", chat_id)
    .then(({ data: members }) => {
      members?.forEach(member => {
        if (member.is_blocked) return;
        const sockets = clientsMap.get(member.user_id);
        sockets?.forEach(s => {
          if (s.readyState === WebSocket.OPEN) {
            s.send(JSON.stringify({
              type: "MESSAGE_READ",
              chatId: chat_id,
              messageId,
              userId
            }));
          }
        });
      });
    });
}
async function broadcastChatEvent(chatId, payload, onlyUserId = null) {
  try {
    const { data: members, error } = await supabaseGlobal.from("chat_members")
      .select("user_id,is_blocked").eq("chat_id", chatId);
    if (error) throw error;
    const encoded = JSON.stringify(payload);
    for (const member of members || []) {
      if (member.is_blocked || (onlyUserId && member.user_id !== onlyUserId)) continue;
      clientsMap.get(member.user_id)?.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) ws.send(encoded);
      });
    }
  } catch {
    console.error("Chat event delivery failed");
  }
}

export function broadcastReaction(chatId, payload) {
  const { messageId, user_id, reaction, removed } = payload;
  return broadcastChatEvent(chatId, { type: "MESSAGE_REACTION", messageId, user_id, reaction, removed });
}
export function broadcastKicked(payload) {
  const { id: targetUserId, group_id, group_name, reason } = payload;
  if (clientsMap.has(targetUserId)) {
    const sockets = clientsMap.get(targetUserId);
    sockets?.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "KICKED_FROM_GROUP",
          group_id,
          group_name,
          reason
        }));
      }
    });
  }
}
export function broadcastMessageDeleted(chat_id, messageId, userId = null) {
  return broadcastChatEvent(chat_id, {
    type: "MESSAGE_DELETED", chatId: chat_id, messageId, userId
  }, userId);
}
export async function broadcastGroupUpdated(chat_id) {
  console.log("Broadcasting GROUP_UPDATED", {chat_id});
  try {
    const { data: members } = await supabaseGlobal
      .from("chat_members")
      .select("user_id,is_blocked")
      .eq("chat_id", chat_id);
    if (!members || members.length === 0) return;
    for (const member of members) {
      if (member.is_blocked) continue;
      const sockets = clientsMap.get(member.user_id);
      sockets?.forEach(s => {
        if (s.readyState === WebSocket.OPEN) {
          s.send(JSON.stringify({
            type: "GROUP_UPDATED",
            group_id: chat_id
          }));
        }
      });
    }
  } catch (err) {
    console.error("Ошибка в broadcastGroupUpdated:", err);
  }
}
export async function broadcastPinToggle(chat_id, message_id, is_pinned) {
  try {
    const { data: members } = await supabaseGlobal
      .from("chat_members")
      .select("user_id,is_blocked")
      .eq("chat_id", chat_id);
    if (!members || members.length === 0) return;
    for (const member of members) {
      if (member.is_blocked) continue;
      const sockets = clientsMap.get(member.user_id);
      sockets?.forEach(s => {
        if (s.readyState === WebSocket.OPEN) {
          s.send(JSON.stringify({
            type: "MESSAGE_PIN_TOGGLED",
            message_id,
            is_pinned,
          }));
        }
      });
    }
  } catch (err) {
    console.error("Ошибка в broadcastPinToggle:", err);
  }
}
export function broadcastTimerUpdate(userId, habitId, timerData) {
  const sockets = clientsMap.get(userId);
  if (!sockets) return;

  const payload = JSON.stringify({
    type: "TIMER_UPDATE",
    habitId: Number(habitId),
    timer: timerData
  });

  sockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  });
}
export default function initWebSocket(supabase, server) {
  supabaseGlobal = supabase;
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16 * 1024 });
  clientsMap = new Map();
  wss.on("connection", async (ws, req) => {
    ws.on("error", () => {});
    try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const ticket = url.searchParams.get("ticket");
    const allowed = (process.env.CLIENT_URL || "https://achievetogether.vercel.app").split(",").map(x => x.trim());
    if (process.env.NODE_ENV !== "production") allowed.push("http://localhost:5173", "http://127.0.0.1:5173");
    if (!allowed.includes(req.headers.origin) || !ticket || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
      ws.close(1008, "Authentication required");
      return;
    }

    const ticketHash = createHash("sha256").update(ticket).digest("hex");
    const { data: tickets, error: ticketError } = await supabase.from("at_ws_tickets")
      .delete().eq("token_hash", ticketHash).gt("expires_at", new Date().toISOString())
      .select("user_id,session_id,auth_version");
    if (ticketError || tickets?.length !== 1) {
      ws.close(1008, "Invalid ticket");
      return;
    }
    const authenticated = tickets[0];
    const userId = authenticated.user_id;
    const { data: account } = await supabase.from("users")
      .select("auth_version").eq("id", userId).maybeSingle();
    if (!account || account.auth_version !== authenticated.auth_version) {
      ws.close(1008, "Expired session");
      return;
    }
    if (authenticated.session_id) {
      const { data: active } = await supabase.from("at_user_sessions")
        .select("id").eq("id", authenticated.session_id).eq("user_id", userId)
        .is("revoked_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (!active) {
        ws.close(1008, "Session revoked");
        return;
      }
    }
    ws.authSessionId = authenticated.session_id;
    ws.authVersion = authenticated.auth_version;
    console.log(`🟢 WS connected: user ${userId}`);
    if (!clientsMap.has(userId)) clientsMap.set(userId, new Set());
    clientsMap.get(userId).add(ws);
    await supabase
      .from("users")
      .update({ last_online: new Date().toISOString() })
      .eq("id", userId);
    // посылаем статус всем
    broadcastUserStatus(userId, true);
    // Отправляем новому подключенному клиенту статус всех онлайн пользователей (с nick)
    for (const [otherUserId] of clientsMap.entries()) {
      if (otherUserId === userId) continue;
      // найдем nick для otherUserId
      const { data: userRow } = await supabase
        .from("users")
        .select("nick")
        .eq("id", otherUserId)
        .single();
      if (await canSeePresence(supabase, userId, otherUserId)) {
        const payload = JSON.stringify({
          type: "USER_STATUS",
          userId: otherUserId,
          nick: userRow?.nick || null,
          isOnline: true
        });
        ws.send(payload);
      }
    }
    const aliveTimer = setInterval(async () => {
      try {
        const { data: account } = await supabase.from("users")
          .select("auth_version").eq("id", userId).maybeSingle();
        if (!account || account.auth_version !== ws.authVersion) {
          ws.close(1008, "Session expired");
          return;
        }
        if (ws.authSessionId) {
          const { data: active } = await supabase.from("at_user_sessions")
            .select("id").eq("id", ws.authSessionId).eq("user_id", userId)
            .is("revoked_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
          if (!active) {
            ws.close(1008, "Session revoked");
            return;
          }
        }
        await supabase.from("users").update({ last_online: new Date().toISOString() }).eq("id", userId);
      } catch (err) {
        console.error("Error updating last_online:", err);
      }
    }, 60000);
    ws.on("message", async (msg) => {
      try {
      let data;
      try { data = JSON.parse(msg.toString()); } catch { return; }
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      if (typeof data.to !== "string" && typeof data.to !== "number") return;
      if (data.type === "TYPING" || data.type === "STOP_TYPING") {
        // Получаем информацию об отправителе
        const { data: fromUser } = await supabaseGlobal
          .from("users")
          .select("username, nick")
          .eq("id", userId)
          .single();

        const payload = JSON.stringify({
          type: data.type,
          to: data.to,
          is_group: data.is_group === true,
          from: userId,
          sender_name: fromUser?.username || fromUser?.nick || 'Аноним',
          chat_id: data.is_group ? data.to : null
        });

        if (data.is_group) {
          const groupId = data.to;
          const { data: members } = await supabaseGlobal
            .from("chat_members")
            .select("user_id,is_blocked")
            .eq("chat_id", groupId);
          if (!members?.some(member => member.user_id === userId && !member.is_blocked)) return;
          if (members) {
            members.forEach(member => {
              if (member.user_id !== userId && !member.is_blocked) { // Исключаем отправителя
                const sockets = clientsMap.get(member.user_id);
                sockets?.forEach(s => {
                  if (s.readyState === WebSocket.OPEN) {
                    s.send(payload);
                  }
                });
              }
            });
          }
        } else {
          // A direct typing event is private chat data, not a user-to-user broadcast.
          // Resolve the recipient and require a shared, unblocked, non-group chat.
          let targetId = null;
          const target = String(data.to);
          let recipient = null;
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)) {
            const { data: recipientById, error: recipientIdError } = await supabaseGlobal
              .from("users")
              .select("id")
              .eq("id", target)
              .maybeSingle();
            if (recipientIdError) return;
            recipient = recipientById;
          }
          if (!recipient) {
            const { data: recipientByNick, error: recipientNickError } = await supabaseGlobal
              .from("users")
              .select("id")
              .eq("nick", target)
              .maybeSingle();
            if (recipientNickError) return;
            recipient = recipientByNick;
          }
          if (!recipient || recipient.id === userId) return;
          targetId = recipient.id;

          const { data: myChats, error: myError } = await supabaseGlobal
            .from("chat_members")
            .select("chat_id,is_blocked,chats!inner(is_group)")
            .eq("user_id", userId)
            .eq("chats.is_group", false);
          if (myError || !myChats) return;
          const allowedIds = myChats.filter(member => !member.is_blocked)
            .map(member => member.chat_id);
          if (!allowedIds.length) return;
          const { data: theirChats, error: theirError } = await supabaseGlobal
            .from("chat_members")
            .select("chat_id,is_blocked,chats!inner(is_group)")
            .eq("user_id", targetId)
            .eq("chats.is_group", false)
            .in("chat_id", allowedIds);
          if (theirError || !theirChats?.some(member => !member.is_blocked)) return;

          const privatePayload = JSON.stringify({
            type: data.type,
            to: targetId,
            is_group: false,
            from: userId,
            sender_name: fromUser?.username || fromUser?.nick || "Аноним",
            chat_id: null
          });
          clientsMap.get(targetId)?.forEach(s => {
            if (s.readyState === WebSocket.OPEN) s.send(privatePayload);
          });
        }
      }
      } catch {
        console.error("WebSocket message handling failed");
      }
    });
    ws.on("close", async () => {
      console.log(`🔴 WS disconnected: user ${userId}`);
      clearInterval(aliveTimer);
      clientsMap.get(userId)?.delete(ws);
      if (!clientsMap.get(userId)?.size) {
        clientsMap.delete(userId);
        await supabase
          .from("users")
          .update({ last_online: new Date().toISOString() })
          .eq("id", userId);
        broadcastUserStatus(userId, false);
      }
    });
    } catch {
      ws.close(1011, "Authentication unavailable");
    }
  });
  broadcastUserStatus = async function (userId, isOnline) {
    let last_online = null;
    let nick = null;
    if (!isOnline) {
      const { data, error } = await supabaseGlobal
        .from("users")
        .select("last_online, nick")
        .eq("id", userId)
        .single();
      if (error) {
        console.log(error)
      }
      if (!error && data) {
        last_online = data.last_online;
        nick = data.nick;
      }
    } else {
      const { data } = await supabaseGlobal
        .from("users")
        .select("nick")
        .eq("id", userId)
        .single();
      nick = data?.nick || null;
    }
    const payload = JSON.stringify({ type: "USER_STATUS", userId, nick, isOnline, last_online });
    for (const [viewerId, sockets] of clientsMap) {
      if (!(await canSeePresence(supabaseGlobal, viewerId, userId))) continue;
      sockets.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      });
    }
  }
  console.log("WebSocket initialized on /ws");
  return wss;
}
