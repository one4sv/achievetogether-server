import { authenticateUser } from "./middleware/token.js";
import { broadcastReaction } from "./ws.js";

export default function (app, supabase) {
  app.post("/reactions", authenticateUser(supabase), async (req, res) => {
    const { mId, reaction } = req.body;
    const { id: user_id } = req.user;

    try {
      // Получаем текущее сообщение
      const { data: message, error } = await supabase
        .from("messages")
        .select("id, reactions")
        .eq("id", mId)
        .single();

      if (error || !message) {
        return res.status(404).json({ success: false, error: "Сообщение не найдено" });
      }

      const reactions = message.reactions || [];

      // Проверяем, есть ли уже реакция пользователя
      const hasReaction = reactions.find(r => r.user_id === user_id && r.reaction === reaction);

      let updatedReactions;
      if (hasReaction) {
        // Удаляем реакцию (toggle off)
        updatedReactions = reactions.filter(r => !(r.user_id === user_id && r.reaction === reaction));
      } else {
        // Добавляем новую реакцию
        updatedReactions = [...reactions, { user_id, reaction }];
      }

      const { error: updateError } = await supabase
        .from("messages")
        .update({ reactions: updatedReactions })
        .eq("id", mId);

      if (updateError) throw updateError;

      // Бродкаст для обновления у собеседника
      broadcastReaction({
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
