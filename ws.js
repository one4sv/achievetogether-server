import { WebSocketServer, WebSocket } from "ws";

let clientsMap = new Map(); // userId -> Set(ws)
let supabaseGlobal; // to share supabase
let broadcastUserStatus; // forward declaration

export async function broadcastNewMessage(chat_id, message) {
  try {
    // Получаем id отправителя
    const senderId = message.sender_id;

    // Получаем ник и username из таблицы users
    const { data: senderData, error: senderError } = await supabaseGlobal
      .from("users")
      .select("nick, username")
      .eq("id", senderId)
      .single();

    if (senderError) {
      console.error("Ошибка получения данных отправителя:", senderError);
    }

    // Получаем участников чата
    const { data: members, error: membersError } = await supabaseGlobal
      .from("chat_members")
      .select("user_id")
      .eq("chat_id", chat_id);

    if (membersError) {
      console.error("Ошибка получения участников:", membersError);
      return;
    }

    // Рассылаем сообщение всем участникам
    members?.forEach(member => {
      const targetId = member.user_id;
      const sockets = clientsMap.get(targetId);
      sockets?.forEach(s => {
        if (s.readyState === WebSocket.OPEN) {
          s.send(JSON.stringify({
            type: "NEW_MESSAGE",
            chatId: chat_id,
            message,
            nick: senderData?.nick || null,
            username: senderData?.username || null
          }));
        }
      });
    });
  } catch (err) {
    console.error("Ошибка в broadcastNewMessage:", err);
  }
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
  for (const [userId, sockets] of clientsMap.entries()) {
    sockets.forEach(ws => {
      ws.send(JSON.stringify({
        type: "MESSAGE_REACTION",
        messageId,
        user_id,
        reaction,
        removed // <-- добавили
      }));
    });
  }
}

export default function initWebSocket(supabase, server) {
  supabaseGlobal = supabase;
  const wss = new WebSocketServer({ server, path: "/ws" });
  clientsMap = new Map(); // userId -> Set(ws)
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
    broadcastUserStatus(userId, true);
    // Отправляем новому подключенному клиенту статус всех онлайн пользователей
    for (const [otherUserId, sockets] of clientsMap.entries()) {
      if (otherUserId === userId) continue;
      const payload = JSON.stringify({
        type: "USER_STATUS",
        userId: otherUserId,
        isOnline: true
      });
      ws.send(payload);
    }
    // Таймер обновления last_online
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
        const targetSockets = clientsMap.get(data.to);
        targetSockets?.forEach(s => {
            if (s.readyState === WebSocket.OPEN) {
                s.send(JSON.stringify({ ...data, from: userId }));
            }
        });
      }
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
    if (!isOnline) {
      const { data, error } = await supabase
        .from("users")
        .select("last_online")
        .eq("id", userId)
        .single();
      if (!error && data) last_online = data.last_online;
    }
    const payload = JSON.stringify({ type: "USER_STATUS", userId, isOnline, last_online });
    // Рассылаем всем активным сокетам
    for (const sockets of clientsMap.values()) {
      sockets.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      });
    }
  }
  console.log("✅ WebSocket initialized on /ws");
}