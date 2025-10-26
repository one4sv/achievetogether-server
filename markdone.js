import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
  app.post("/markdone", authenticateUser(supabase), async (req, res) => {
    const { id: user_id } = req.user;
    const { habit_id, date } = req.body;

    try {
      const today = new Date().toLocaleDateString("en-CA", {
        timeZone: "Europe/Moscow"
      });

      // Если date есть — берём её, иначе today
      const targetDate = date && date.trim() !== "" ? date : today;

      const { data: existing, error: selectError } = await supabase
        .from("habit_completions")
        .select("id")
        .eq("habit_id", habit_id)
        .eq("user_id", user_id)
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
          .eq("user_id", user_id)
          .eq("completed_at", targetDate);

        if (deleteError) {
          console.error("Ошибка удаления:", deleteError);
          return res.status(500).json({ success: false, error: deleteError.message });
        }

        return res.status(200).json({ success: true, action: "deleted" });
      } else {
        const { data, error: insertError } = await supabase
          .from("habit_completions")
          .insert([
            {
              habit_id,
              user_id,
              completed_at: targetDate,
            },
          ]);

        if (insertError) {
          console.error("Ошибка вставки:", insertError);
          return res.status(500).json({ success: false, error: insertError.message });
        }

        return res.status(200).json({ success: true, action: "inserted", data });
      }
    } catch (err) {
      console.error("Ошибка сервера:", err);
      return res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}
