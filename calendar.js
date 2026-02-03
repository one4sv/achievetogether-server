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
        .select("id, name, is_archived")
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

      // Собираем календарь
      const mapped = [
        ...(completions ?? []).map(item => {
          const habit = habits.find(h => h.id === item.habit_id);
          const comment = comments.find(c => c.habit_id === item.habit_id && c.date === item.completed_at)?.comment ?? "";
          return {
            habitId: String(item.habit_id),
            habitName: habit ? habit.name : "Неизвестная привычка",
            date: item.completed_at,
            comment,
            created_at: item.created_at,
            isDone: true,
            is_archived: habit?.is_archived ?? false
          };
        }),
        ...(comments ?? [])
          .filter(c => !completions.some(comp => comp.habit_id === c.habit_id && comp.completed_at === c.date))
          .map(c => {
            const habit = habits.find(h => h.id === c.habit_id);
            return {
              habitId: String(c.habit_id),
              habitName: habit ? habit.name : "Неизвестная привычка",
              date: c.date,
              comment: c.comment,
              isDone: false,
              is_archived: habit?.is_archived ?? false
            };
          })
      ];

      res.json({ success: true, calendar: mapped });
    } catch (err) {
      console.error("Ошибка запроса к Supabase:", err);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });

  app.get("/calendar/:id", authenticateUser(supabase), async (req, res) => {
    const habitId = parseInt(req.params.id);

    if (isNaN(habitId)) {
      return res.status(400).json({ success: false, error: "Неверный ID привычки" });
    }

    try {
      // Берём привычку (с is_archived)
      const { data: habit, error: errorHabit } = await supabase
        .from("habits")
        .select("id, name, is_archived")
        .eq("id", habitId)
        .single();

      if (errorHabit || !habit) {
        return res.status(errorHabit ? 500 : 404).json({ 
          success: false, 
          error: errorHabit ? "Ошибка при получении привычки" : "Привычка не найдена" 
        });
      }

      // Все выполнения
      const { data: completions, error: errorComp } = await supabase
        .from("habit_completions")
        .select("completed_at, created_at")
        .eq("habit_id", habitId);

      if (errorComp) {
        console.log(errorComp);
        return res.status(500).json({ success: false, error: "Ошибка при получении выполнений" });
      }

      // Все комментарии
      const { data: comments, error: errorComments } = await supabase
        .from("completions_comments")
        .select("comment, date")
        .eq("habit_id", habitId);

      if (errorComments) {
        console.log(errorComments);
        return res.status(500).json({ success: false, error: "Ошибка при получении комментариев" });
      }

      // Календарь для одной привычки
      const mapped = [
        ...(completions ?? []).map(item => ({
          habitId: String(habit.id),
          habitName: habit.name,
          date: item.completed_at,
          comment: comments.find(c => c.date === item.completed_at)?.comment ?? "",
          created_at: item.created_at,
          isDone: true,
          is_archived: habit.is_archived
        })),
        ...(comments ?? [])
          .filter(c => !(completions ?? []).some(comp => comp.completed_at === c.date))
          .map(c => ({
            habitId: String(habit.id),
            habitName: habit.name,
            date: c.date,
            comment: c.comment,
            isDone: false,
            is_archived: habit.is_archived
          }))
      ];

      // Все исторические таймеры привычки
      const { data: timersData, error: timersError } = await supabase
        .from("habit_timers")
        .select("id, started_at, end_at, status, pauses, circles")
        .eq("habit_id", habitId)
        .order("started_at", { ascending: false });

      if (timersError) {
        console.log(timersError);
        return res.status(500).json({ success: false, error: "Ошибка при получении таймеров" });
      }

      res.json({ 
        success: true, 
        calendar: mapped, 
        timers: timersData || [] 
      });
    } catch (err) {
      console.error("Ошибка запроса к Supabase:", err);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}