import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
  app.post("/daycomment", authenticateUser(supabase), async (req, res) => {
    const { id: user_id } = req.user;
    const { habit_id, text, date } = req.body;

    try {
      const today = new Date().toLocaleDateString("en-CA", {
        timeZone: "Europe/Moscow",
      });
      const targetDate = date && date.trim() !== "" ? date : today;

      const { data: existingComment, error: selectError } = await supabase
        .from("completions_comments")
        .select("id")
        .eq("habit_id", habit_id)
        .eq("user_id", user_id)
        .eq("date", targetDate)
        .maybeSingle();

      if (selectError) {
        console.error("Ошибка проверки комментария:", selectError);
        return res.status(500).json({ success: false, error: selectError.message });
      }

      if (existingComment) {
        // Обновляем комментарий
        const { error: updateError } = await supabase
          .from("completions_comments")
          .update({ comment: text })
          .eq("id", existingComment.id);

        if (updateError) {
          console.error("Ошибка обновления комментария:", updateError);
          return res.status(500).json({ success: false, error: updateError.message });
        }

        return res.status(200).json({ success: true, action: "updated" });
      } else {
        // Создаём новый комментарий
        const { error: insertError } = await supabase
          .from("completions_comments")
          .insert([
            {
              habit_id,
              user_id,
              comment: text,
              date: targetDate,
            },
          ]);

        if (insertError) {
          console.error("Ошибка вставки комментария:", insertError);
          return res.status(500).json({ success: false, error: insertError.message });
        }

        return res.status(200).json({ success: true, action: "inserted" });
      }
    } catch (err) {
      console.error("Ошибка сервера:", err);
      return res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}
