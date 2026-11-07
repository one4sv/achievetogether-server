import { authenticateUser } from "../../middleware/token.js";
import { broadcastNewMessage, broadcastPinToggle } from "../../realtime/ws.js";
import { canAccessMessage } from "../../utils/messageAccess.js";
import { hasServerPermission } from "../../utils/hasPermission.js";
import { PERMS } from "../../config/permissions.js";

export default function(app, supabase) {
  app.post("/pinmess", authenticateUser(supabase), async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).json({ success: false, error: "Не авторизован" });
      const userId = req.user.id;
      const { message_id } = req.body;

      if (!message_id) {
        return res.status(400).json({ success: false, error: "Не указан message_id" });
      }

      const msgId = parseInt(message_id, 10);
      if (isNaN(msgId)) {
        return res.status(400).json({ success: false, error: "Некорректный message_id" });
      }

      // Получаем сообщение
      const { data: message, error: msgError } = await supabase
        .from("messages")
        .select("id, chat_id, is_pinned, is_system, hidden")
        .eq("id", msgId)
        .single();

      if (msgError || !message) {
        return res.status(404).json({ success: false, error: "Сообщение не найдено" });
      }

      if (!(await canAccessMessage(supabase, message, userId))) {
        return res.status(403).json({ success: false, error: "Нет доступа к сообщению" });
      }
      if (message.is_system) {
        return res.status(400).json({ success: false, error: "Системные сообщения нельзя закреплять" });
      }

      const chatId = message.chat_id;

      // Тип чата
      const { data: chat, error: chatError } = await supabase
        .from("chats")
        .select("is_group")
        .eq("id", chatId)
        .single();

      if (chatError || !chat) {
        return res.status(500).json({ success: false, error: "Ошибка получения данных чата" });
      }
      if (chat.is_group && !(await hasServerPermission(supabase, chatId, userId, PERMS.pin_messages))) {
        return res.status(403).json({ success: false, error: "Нет прав на закрепление" });
      }

      // Toggle
      const newPinned = !message.is_pinned;

      // Обновляем is_pinned
      const { error: updateError } = await supabase
        .from("messages")
        .update({ is_pinned: newPinned })
        .eq("id", msgId);

      if (updateError) {
        console.error("[pinmess] Ошибка обновления is_pinned:", updateError);
        return res.status(500).json({ success: false, error: "Ошибка закрепления" });
      }

      // Подгружаем username/nick автора системного сообщения (аналогично тому, как в /chat)
      const { data: senderInfo } = await supabase
        .from("users")
        .select("username, nick")
        .eq("id", userId)
        .single();

      const senderName = senderInfo ? (senderInfo.username || senderInfo.nick) : null;
      const senderNick = senderInfo ? senderInfo.nick : null;

      // Системное сообщение — только действие в content (имя берётся из sender_name на фронте)
      const action = newPinned ? "закрепил" : "открепил";

      const { data: sysMessageRaw, error: sysMsgError } = await supabase
        .from("messages")
        .insert({
          chat_id: chatId,
          sender_id: userId,
          content: `${action} сообщение`,
          is_system: true,
          created_at: new Date().toISOString(),
          answer_id:message.id
        })
        .select("*")
        .single();

      if (sysMsgError) {
        console.warn("[pinmess] Не удалось добавить системное сообщение:", sysMsgError);
      }

      // Формируем полное системное сообщение с sender_name/sender_nick (как в отправке обычных сообщений)
      let sysMessage = null;
      if (sysMessageRaw) {
        sysMessage = {
          ...sysMessageRaw,
          sender_name: senderName,
          sender_nick: senderNick,
          files: [], // системное — без файлов
          reactions: [],
          read_by: [],
          edited: false,
          is_system: true,
          is_pinned: false,
        };

        // Broadcast системного сообщения (уведомления по note + полное сообщение с sender_name)
        broadcastNewMessage(chatId, sysMessage);
      }

      // Broadcast изменения pin — всем онлайн-участникам чата (мгновенное обновление UI)
      broadcastPinToggle(chatId, msgId, newPinned);

      return res.json({
        success: true,
        pinned: newPinned,
        message_id: msgId,
      });
    } catch (err) {
      console.error("[pinmess] unexpected error:", err);
      return res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}