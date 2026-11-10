import { authenticateUser } from "../../middleware/token.js";
import { broadcastReaction } from "../../realtime/ws.js";
import { canAccessMessage } from "../../utils/messageAccess.js";

export default function (app, supabase) {
  app.post("/reactions", authenticateUser(supabase), async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ success: false, error: "Не авторизован" });
    const { mId, reaction } = req.body || {};
    if (!Number.isSafeInteger(Number(mId)) || Number(mId) <= 0 ||
        typeof reaction !== "string" || !reaction.trim() || reaction.length > 64) {
      return res.status(400).json({ success: false, error: "Некорректная реакция" });
    }
    const { id: user_id } = req.user;

    try {
      // Получаем текущее сообщение
      const { data: message, error } = await supabase
        .from("messages")
        .select("id, chat_id, hidden, reactions")
        .eq("id", mId)
        .single();

      if (error || !message) {
        return res.status(404).json({ success: false, error: "Сообщение не найдено" });
      }

      const reactions = Array.isArray(message.reactions) ? message.reactions : [];
      if (!(await canAccessMessage(supabase, message, user_id))) {
        return res.status(403).json({ success: false, error: "Нет доступа к сообщению" });
      }

      // У пользователя может быть только одна реакция на сообщение.
      // Повторное нажатие убирает её, другая реакция заменяет предыдущую.
      const hasReaction = reactions.some(r => r.user_id === user_id && r.reaction === reaction);
      const updatedReactions = reactions.filter(r => r.user_id !== user_id);
      if (!hasReaction) updatedReactions.push({ user_id, reaction });

      const { error: updateError } = await supabase
        .from("messages")
        .update({ reactions: updatedReactions })
        .eq("id", mId);

      if (updateError) throw updateError;

      // Бродкаст для обновления у собеседника
      broadcastReaction(message.chat_id, {
        messageId: mId,
        user_id,
        reaction,
        removed: !!hasReaction
      });

      return res.json({ success: true });
    } catch (e) {
      console.error("Ошибка при установке реакции:", e);
      return res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}
