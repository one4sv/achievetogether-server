import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
  // Календарь всех привычек пользователя
  app.get("/calendar", authenticateUser(supabase), async (req, res) => {
    const { id: user_id } = req.user;

    try {
      // Берём все даты выполнений
      const { data: completions, error: errorComp } = await supabase
        .from("habit_completions")
        .select("completed_at, habit_id, created_at")
        .eq("user_id", user_id);

      if (errorComp) {
        console.log(errorComp);
        return res.status(500).json({ success: false, error: "Ошибка при получении дат выполнения" });
      }

      // Берём все привычки
      const { data: habits, error: errorHabit } = await supabase
        .from("habits")
        .select("id, name, is_archieve")
        .eq("user_id", user_id);

      if (errorHabit) {
        console.log(errorHabit);
        return res.status(500).json({ success: false, error: "Ошибка при получении привычек" });
      }

      // Берём все комментарии пользователя
      const { data: comments, error: errorComments } = await supabase
        .from("completions_comments")
        .select("habit_id, comment, date")
        .eq("user_id", user_id);

      if (errorComments) {
        console.log(errorComments);
        return res.status(500).json({ success: false, error: "Ошибка при получении комментариев" });
      }

      // Собираем календарь: комбинируем выполнения и комментарии
      const mapped = [
        // Выполненные привычки
        ...(completions ?? []).map(item => {
          const habit = habits.find(h => h.id === item.habit_id);
          const comment = comments.find(c => c.habit_id === item.habit_id && c.date === item.completed_at)?.comment ?? "";
          return {
            habitId: item.habit_id,
            habitName: habit ? habit.name : "Неизвестная привычка",
            date: item.completed_at,
            comment,
            created_at: item.created_at,
            isDone: true, // <-- добавляем
            is_archieve: habit?.is_archieve ?? false
          };
        }),
        // Комментарии без выполнения
        ...(comments ?? [])
          .filter(c => !completions.some(comp => comp.habit_id === c.habit_id && comp.completed_at === c.date))
          .map(c => {
            const habit = habits.find(h => h.id === c.habit_id);
            return {
              habitId: c.habit_id,
              habitName: habit ? habit.name : "Неизвестная привычка",
              date: c.date,
              comment: c.comment,
              isDone: false, // <-- явно false
              is_archieve:habit?.is_archieve ?? false
            };
          })
      ];

      res.json({ success: true, calendar: mapped });
    } catch (err) {
      console.error("Ошибка запроса к Supabase:", err);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });

  // Календарь по конкретной привычке
  app.get("/calendar/:id", authenticateUser(supabase), async (req, res) => {
    const { id: habit_id } = req.params;

    try {
      // Берём привычку
      const { data: habit, error: errorHabit } = await supabase
        .from("habits")
        .select("id, name")
        .eq("id", habit_id)
        .single();

      if (errorHabit || !habit) {
        console.log(errorHabit);
        return res.status(500).json({ success: false, error: "Ошибка при получении привычки" });
      }

      // Берём все completions
      const { data: completions, error: errorComp } = await supabase
        .from("habit_completions")
        .select("completed_at, created_at")
        .eq("habit_id", habit_id);

      if (errorComp) {
        console.log(errorComp);
        return res.status(500).json({ success: false, error: "Ошибка при получении выполнений" });
      }

      // Берём все комментарии
      const { data: comments, error: errorComments } = await supabase
        .from("completions_comments")
        .select("comment, date")
        .eq("habit_id", habit_id);

      if (errorComments) {
        console.log(errorComments);
        return res.status(500).json({ success: false, error: "Ошибка при получении комментариев" });
      }

      const mapped = [
        ...(completions ?? []).map(item => ({
          habitId: habit.id.toString(),
          habitName: habit.name,
          date: item.completed_at,
          comment: comments.find(c => c.date === item.completed_at)?.comment ?? "",
          created_at: item.created_at,
          isDone: true,
        })),
        ...(comments ?? []).filter(c => !(completions ?? []).some(comp => comp.completed_at === c.date))
          .map(c => ({
            habitId: habit.id.toString(),
            habitName: habit.name,
            date: c.date,
            comment: c.comment,
            isDone: false,
          }))
      ];

      res.json({ success: true, calendar: mapped });
    } catch (err) {
      console.error("Ошибка запроса к Supabase:", err);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}
