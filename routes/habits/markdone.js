import { requireHabitPermission } from "../../utils/habitAccess.js";
import { canCompleteHabitDay } from "../../utils/habitCompletionDate.js";
import { authenticateUser } from "../../middleware/token.js";
import { broadcastHabitCommentUpdated } from "../../realtime/ws.js";

export default function (app, supabase) {
  app.post("/markdone", authenticateUser(supabase), requireHabitPermission(supabase, "complete"), async (req, res) => {
    const { id: user_id } = req.user;
    const { habit_id, date } = req.body;

    try {
      if (!habit_id) return res.status(400).json({ success: false });
      const progressUserId = req.habitAccess.completion_user_id;
      const today = new Date().toLocaleDateString("en-CA", {
        timeZone: "Europe/Moscow"
      });

      // Если date есть — берём её, иначе today
      const targetDate = typeof date === "string" && date.trim() !== "" ? date.trim() : today;
      if (typeof targetDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
        return res.status(400).json({ success: false, error: "Неверная дата" });
      }
      if (!canCompleteHabitDay(req.habitAccess, targetDate)) {
        return res.status(403).json({
          success: false,
          error: "Нельзя отмечать выполнение раньше даты вступления в беседу"
        });
      }

      const { data: existing, error: selectError } = await supabase
        .from("habit_completions")
        .select("id")
        .eq("habit_id", habit_id)
        .eq("user_id", progressUserId)
        .eq("completed_at", targetDate);

      if (selectError) {
        console.error("Ошибка проверки:", selectError);
        return res.status(500).json({ success: false, error: selectError.message });
      }

      if (existing.length > 0) {
        const { error: deleteError } = await supabase
          .from("habit_completions")
          .delete()
          .eq("habit_id", habit_id)
          .eq("user_id", progressUserId)
          .eq("completed_at", targetDate);

        if (deleteError) {
          console.error("Ошибка удаления:", deleteError);
          return res.status(500).json({ success: false, error: deleteError.message });
        }

        void broadcastHabitCommentUpdated(supabase, habit_id, targetDate);
        return res.status(200).json({ success: true, action: "deleted" });
      } else {
        const { data, error: insertError } = await supabase
          .from("habit_completions")
          .insert([
            {
              habit_id,
              user_id: progressUserId,
              actor_user_id: user_id,
              completed_at: targetDate,
            },
          ]);

        if (insertError) {
          console.error("Ошибка вставки:", insertError);
          return res.status(500).json({ success: false, error: insertError.message });
        }

        void broadcastHabitCommentUpdated(supabase, habit_id, targetDate);
        return res.status(200).json({ success: true, action: "inserted", data });
      }
    } catch (err) {
      console.error("Ошибка сервера:", err);
      return res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}
