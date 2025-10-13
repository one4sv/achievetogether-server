import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
  // Календарь всех привычек пользователя
  app.get("/calendar", authenticateUser(supabase), async (req, res) => {
    const { id: user_id } = req.user;

    try {
      const { data: calendar, error: errorComp } = await supabase
        .from("habit_completions")
        .select("completed_at, habit_id")
        .eq("user_id", user_id);

      if (errorComp) {
        console.log(errorComp);
        return res.status(500).json({ success: false, error: "Ошибка при получении дат выполнения" });
      }

      const { data: habits, error: errorHabit } = await supabase
        .from("habits")
        .select("id, name")
        .eq("user_id", user_id);

      if (errorHabit) {
        console.log(errorHabit);
        return res.status(500).json({ success: false, error: "Ошибка при получении привычек" });
      }

      const mapped = (calendar ?? []).map(item => {
        const habit = habits.find(h => h.id === item.habit_id);
        return {
          habitId: item.habit_id,
          habitName: habit ? habit.name : "Неизвестная привычка",
          date: item.completed_at,
        };
      });

      res.json({ success: true, calendar: mapped });
    } catch (err) {
      console.error("Ошибка запроса к Supabase:", err);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });

  app.get("/calendar/:id", authenticateUser(supabase), async (req, res) => {
    const { id: habit_id } = req.params;

    try {
      const { data: calendar, error: errorComp } = await supabase
        .from("habit_completions")
        .select("completed_at, comment")
        .eq("habit_id", habit_id);

      if (errorComp) {
        console.log(errorComp);
        return res.status(500).json({ success: false, error: "Ошибка при получении дат выполнения" });
      }

      const { data: habit, error: errorHabit } = await supabase
        .from("habits")
        .select("id, name")
        .eq("id", habit_id)
        .single();

      if (errorHabit) {
        console.log(errorHabit);
        return res.status(500).json({ success: false, error: "Ошибка при получении привычки" });
      }

      res.json({
        success: true,
        calendar: (calendar ?? []).map(item => ({
          habitId: habit.id,
          habitName: habit.name,
          date: item.completed_at,
          comment: item.comment ?? ""
        })),
      });
    } catch (err) {
      console.error("Ошибка запроса к Supabase:", err);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}
