import { WebSocketServer, WebSocket } from "ws";

let clientsMap = new Map(); // userId -> Set(ws)
let supabaseGlobal;
let broadcastUserStatus;

export async function broadcastNewMessage(chat_id, message) {
  try {
    const senderId = message.sender_id;
    const { data: senderData } = await supabaseGlobal
      .from("users")
      .select("nick, username")
      .eq("id", senderId)
      .single();

    // Получаем участников чата с их настройками уведомлений (note из chat_members)
    const { data: members } = await supabaseGlobal
      .from("chat_members")
      .select("user_id, note")
      .eq("chat_id", chat_id);

    // Получаем глобальные настройки для всех участников
    const userIds = members?.map(m => m.user_id) || [];
    const { data: settingsList } = await supabaseGlobal
      .from("settings")
      .select("user_id, all_note, new_mess_note")
      .in("user_id", userIds);

    // Создаем мапу userId => settings
    const settingsMap = new Map(settingsList.map(s => [s.user_id, s]));

    for (const member of members || []) {
      const userId = member.user_id;
      const userSettings = settingsMap.get(userId);

      // Проверяем настройки (если настроек нет, считаем true по умолчанию)
      const allNote = userSettings?.all_note ?? true;
      const newMessNote = userSettings?.new_mess_note ?? true;
      const chatNote = member.note;
      console.log("UserId:", userId, "allNote:", allNote, "newMessNote:", newMessNote, "chatNote:", chatNote);
      
      if (allNote && newMessNote && chatNote) {
        const sockets = clientsMap.get(userId);
        sockets?.forEach(s => {
          if (s.readyState === WebSocket.OPEN) {
            s.send(JSON.stringify({
              type: "NEW_MESSAGE",
              chatId: chat_id,
              message,
              nick: senderData?.nick || null,
              username: senderData?.username || null,
              is_note: chatNote
            }));
          }
        });
      }
    }
  } catch (err) {
    console.error("Ошибка в broadcastNewMessage:", err);
  }
}

export function broadcastMessageEdited(chat_id, message) {
  supabaseGlobal
    .from("chat_members")
    .select("user_id")
    .eq("chat_id", chat_id)
    .then(({ data: members }) => {
      members?.forEach(member => {
        const sockets = clientsMap.get(member.user_id);
        sockets?.forEach(s => {
          if (s.readyState === WebSocket.OPEN) {
            s.send(JSON.stringify({
              type: "MESSAGE_EDITED",
              chatId: chat_id,
              message
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
    .select("user_id")
    .eq("chat_id", chat_id)
    .then(({ data: members }) => {
      members?.forEach(member => {
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

export function broadcastReaction(payload) {
  const { messageId, user_id, reaction, removed } = payload;
  for (const sockets of clientsMap.values()) {
    sockets.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "MESSAGE_REACTION",
          messageId,
          user_id,
          reaction,
          removed
        }));
      }
    });
  }
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
          reason // "kicked" или "left"
        }));
      }
    });
  }
}

export function broadcastMessageDeleted(chat_id, messageId, userId = null) {
    console.log("Broadcasting MESSAGE_DELETED", { chat_id, messageId, userId });
    for (const sockets of clientsMap.values()) {
        sockets.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: "MESSAGE_DELETED",
                    chatId: chat_id,
                    messageId,
                    userId
                }));
                console.log("Sent to a client");
            }
        });
    }
}
export function broadcastGroupUpdated(chat_id) {
  supabaseGlobal
    .from("chat_members")
    .select("user_id")
    .eq("chat_id", chat_id)
    .then(({ data: members }) => {
      members?.forEach(member => {
        const sockets = clientsMap.get(member.user_id);
        sockets?.forEach(s => {
          if (s.readyState === WebSocket.OPEN) {
            s.send(JSON.stringify({
              type: "GROUP_UPDATED",
              group_id: chat_id
            }));
          }
        });
      });
    })
    .catch(err => console.error("Ошибка в broadcastGroupUpdated:", err));
}

export default function initWebSocket(supabase, server) {
  supabaseGlobal = supabase;
  const wss = new WebSocketServer({ server, path: "/ws" });
  clientsMap = new Map();
  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.searchParams.get("userId");
    if (!userId) {
      ws.close(1008, "No userId provided");
      return;
    }
    console.log(`🟢 WS connected: user ${userId}`);
    if (!clientsMap.has(userId)) clientsMap.set(userId, new Set());
    clientsMap.get(userId).add(ws);
    // Обновляем last_online
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
      const payload = JSON.stringify({
        type: "USER_STATUS",
        userId: otherUserId,
        nick: userRow?.nick || null,
        isOnline: true
      });
      ws.send(payload);
    }
    const aliveTimer = setInterval(async () => {
      try {
        await supabase
          .from("users")
          .update({ last_online: new Date().toISOString() })
          .eq("id", userId);
      } catch (err) {
        console.error("Error updating last_online:", err);
      }
    }, 60000);
    ws.on("message", async (msg) => {
      const data = JSON.parse(msg.toString());
      if (data.type === "TYPING" || data.type === "STOP_TYPING") {
        // data.to может быть id или nick — сначала пробуем как id
        let targetSockets = clientsMap.get(data.to);
        if (!targetSockets) {
          // попробуем найти пользователя по nick
          try {
            const { data: userByNick } = await supabaseGlobal
              .from("users")
              .select("id")
              .eq("nick", data.to)
              .single();
            if (userByNick) {
              targetSockets = clientsMap.get(userByNick.id);
            }
          } catch (err) {
            console.error("Ошибка поиска пользователя по nick для TYPING:", err);
          }
        }
        // Получаем nick отправителя
        const { data: fromUser } = await supabaseGlobal
          .from("users")
          .select("nick")
          .eq("id", userId)
          .single();
        targetSockets?.forEach(s => {
          if (s.readyState === WebSocket.OPEN) {
            s.send(JSON.stringify({ ...data, from: fromUser?.nick || null }));  // Изменено на from: nick
          }
        });
      }
      // сюда можно добавить обработку других типов (реакции и т.д.)
    });
    ws.on("close", async () => {
      console.log(`🔴 WS disconnected: user ${userId}`);
      clearInterval(aliveTimer);
      clientsMap.get(userId)?.delete(ws);
      if (!clientsMap.get(userId)?.size) {
        clientsMap.delete(userId);
        // Обновляем last_online
        await supabase
          .from("users")
          .update({ last_online: new Date().toISOString() })
          .eq("id", userId);
        broadcastUserStatus(userId, false);
      }
    });
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
      if (!error && data) {
        last_online = data.last_online;
        nick = data.nick;
      }
    } else {
      // Если онлайн — можно получить nick всё равно (для единообразия)
      const { data } = await supabaseGlobal
        .from("users")
        .select("nick")
        .eq("id", userId)
        .single();
      nick = data?.nick || null;
    }
    const payload = JSON.stringify({ type: "USER_STATUS", userId, nick, isOnline, last_online });
    for (const sockets of clientsMap.values()) {
      sockets.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      }
    );
    }
    console.log("✅ WebSocket initialized on /ws");
  }
}