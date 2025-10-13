import { WebSocketServer, WebSocket } from "ws";

export default function initWebSocket(supabase, server) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clientsMap = new Map(); // userId -> Set(ws)

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
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === "SEND_MESSAGE") {
          const { receiver_id, text } = data;
          if (!text || !receiver_id) return;

          // Поиск чата
          const { data: chat_members, error: cmError } = await supabase
            .from("chat_members")
            .select("chat_id")
            .in("user_id", [userId, receiver_id]);

          if (cmError) {
            console.error("Supabase chat_members error:", cmError);
            return;
          }

          let chat_id = null;
          if (chat_members && chat_members.length >= 2) {
            const chatCount = {};
            chat_members.forEach(cm => {
              const cid = String(cm.chat_id);
              chatCount[cid] = (chatCount[cid] || 0) + 1;
            });
            chat_id = Object.keys(chatCount).find(id => chatCount[id] === 2);
          }

          if (!chat_id) {
            const { data: newChat, error: newChatErr } = await supabase
              .from("chats")
              .insert({})
              .select()
              .single();
            if (newChatErr) return console.error("Create chat error:", newChatErr);

            chat_id = newChat.id;
            await supabase.from("chat_members").insert([
              { chat_id, user_id: userId },
              { chat_id, user_id: receiver_id }
            ]);
          }

          const { data: message, error: msgError } = await supabase
            .from("messages")
            .insert([{ sender_id: userId, chat_id, content: text }])
            .select()
            .single();

          if (msgError) {
            console.error("Insert message error:", msgError);
            return;
          }

          const { data: members } = await supabase
            .from("chat_members")
            .select("user_id")
            .eq("chat_id", chat_id);

          // Отправка сообщения всем участникам чата
          members?.forEach(member => {
            const targetId = member.user_id;
            const sockets = clientsMap.get(targetId);
            sockets?.forEach(s => {
              if (s.readyState === WebSocket.OPEN) {
                s.send(JSON.stringify({ type: "NEW_MESSAGE", chatId: chat_id, message }));
              }
            });
          });
        }
      } catch (err) {
        console.error("WS message error:", err);
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

  async function broadcastUserStatus(userId, isOnline) {
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
