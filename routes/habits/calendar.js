import { filterBlockedHabitMemberships, getHabitAccess, requireHabitPermission } from "../../utils/habitAccess.js";
import { authenticateUser } from "../../middleware/token.js";

export default function (app, supabase) {
  // Календарь всех привычек пользователя
  app.get("/calendar", authenticateUser(supabase), async (req, res) => {
    const { id: user_id } = req.user;

    try {
      const { data: memberships, error: membersError } = await supabase
        .from("habit_members").select("habit_id")
        .eq("user_id", user_id).eq("status", "accepted");
      if (membersError) throw membersError;
      const memberIds = (memberships || []).map(item => item.habit_id);
      const { data: allHabits, error: habitsError } = await supabase
        .from("habits").select("id, name, ongoing, user_id, chat_id, completion_mode")
        .or(`user_id.eq.${user_id}${memberIds.length ? `,id.in.(${memberIds.join(",")})` : ""}`);
      if (habitsError) throw habitsError;
      const habits = await filterBlockedHabitMemberships(supabase, allHabits, user_id);
      if (!habits.length) return res.json({ success: true, calendar: [] });
      const habitIds = habits.map(habit => habit.id);
      const habitsById = new Map(habits.map(habit => [habit.id, habit]));
      const progressIds = [...new Set([
        user_id,
        ...habits.filter(habit => habit.completion_mode === "shared").map(habit => habit.user_id)
      ])];

      const { data: allCompletions, error: errorComp } = await supabase
        .from("habit_completions").select("completed_at, habit_id, user_id, created_at")
        .in("habit_id", habitIds).in("user_id", progressIds);
      if (errorComp) throw errorComp;
      const completions = (allCompletions || []).filter(item => {
        const habit = habitsById.get(item.habit_id);
        return habit && item.user_id === (habit.completion_mode === "shared" ? habit.user_id : user_id);
      });

      const { data: comments, error: errorComments } = await supabase
        .from("completions_comments").select("habit_id, comment, date")
        .eq("user_id", user_id).in("habit_id", habitIds);
      if (errorComments) throw errorComments;

      const { data: planned, error: errorPlanned } = await supabase
        .from("habit_planned").select("habit_id, planned_at")
        .in("habit_id", habitIds);
      if (errorPlanned) throw errorPlanned;

      // Собираем календарь
      const mapped = [
        ...(completions ?? []).map(item => {
          const habit = habits.find(h => h.id === item.habit_id);
          const comment = comments.find(
            c => c.habit_id === item.habit_id && c.date === item.completed_at
          )?.comment ?? "";

          return {
            habitId: String(item.habit_id),
            habitName: habit?.name ?? "Неизвестная привычка",
            date: item.completed_at,
            comment,
            created_at: item.created_at,
            isDone: true,
            isPlanned: false,
            ongoing: habit?.ongoing ?? true
          };
        }),

        ...(comments ?? [])
          .filter(c =>
            !(completions ?? []).some(
              comp =>
                comp.habit_id === c.habit_id &&
                comp.completed_at === c.date
            )
          )
          .map(c => {
            const habit = habits.find(h => h.id === c.habit_id);

            return {
              habitId: String(c.habit_id),
              habitName: habit?.name ?? "Неизвестная привычка",
              date: c.date,
              comment: c.comment,
              isDone: false,
              isPlanned: false,
              ongoing: habit?.ongoing ?? true
            };
          }),

        ...(planned ?? [])
          .filter(p =>
            !(completions ?? []).some(
              c =>
                c.habit_id === p.habit_id &&
                c.completed_at === p.planned_at
            ) &&
            !(comments ?? []).some(
              c =>
                c.habit_id === p.habit_id &&
                c.date === p.planned_at
            )
          )
          .map(p => {
            const habit = habits.find(h => h.id === p.habit_id);

            return {
              habitId: String(p.habit_id),
              habitName: habit?.name ?? "Неизвестная привычка",
              date: p.planned_at,
              comment: "",
              isDone: false,
              isPlanned: true,
              ongoing: habit?.ongoing ?? true
            };
          })
      ];

      res.json({ success: true, calendar: mapped });
    } catch (err) {
      console.error("Ошибка запроса к Supabase:", err);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });

  app.get("/calendar/:id", authenticateUser(supabase), requireHabitPermission(supabase, "view"), async (req, res) => {
    const habitId = parseInt(req.params.id);

    if (isNaN(habitId)) {
      return res.status(400).json({ success: false, error: "Неверный ID привычки" });
    }

    try {
      const { data: habit, error: errorHabit } = await supabase
        .from("habits")
        .select("id, name, ongoing")
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
        .eq("habit_id", habitId)
        .eq("user_id", req.habitAccess.completion_user_id);

      if (errorComp) {
        console.log(errorComp);
        return res.status(500).json({ success: false, error: "Ошибка при получении выполнений" });
      }

      // Все комментарии
      const { data: comments, error: errorComments } = await supabase
        .from("completions_comments")
        .select("comment, date")
        .eq("habit_id", habitId)
        .eq("user_id", req.user.id);

      if (errorComments) {
        console.log(errorComments);
        return res.status(500).json({ success: false, error: "Ошибка при получении комментариев" });
      }

      const { data: planned, error: plannedError } = await supabase
        .from("habit_planned")
        .select("planned_at")
        .eq("habit_id", habitId);

      if (plannedError) {
        console.log(plannedError);
        return res.status(500).json({
          success: false,
          error: "Ошибка при получении планов"
        });
      }

      const mapped = [
        ...(completions ?? []).map(item => ({
          habitId: String(habit.id),
          habitName: habit.name,
          date: item.completed_at,
          comment: comments.find(c => c.date === item.completed_at)?.comment ?? "",
          created_at: item.created_at,
          isDone: true,
          isPlanned: false,
          ongoing: habit.ongoing
        })),

        ...(comments ?? [])
          .filter(c =>
            !(completions ?? []).some(
              comp => comp.completed_at === c.date
            )
          )
          .map(c => ({
            habitId: String(habit.id),
            habitName: habit.name,
            date: c.date,
            comment: c.comment,
            isDone: false,
            isPlanned: false,
            ongoing: habit.ongoing
          })),

        ...(planned ?? [])
          .filter(p =>
            !(completions ?? []).some(
              comp => comp.completed_at === p.planned_at
            ) &&
            !(comments ?? []).some(
              c => c.date === p.planned_at
            )
          )
          .map(p => ({
            habitId: String(habit.id),
            habitName: habit.name,
            date: p.planned_at,
            comment: "",
            isDone: false,
            isPlanned: true,
            ongoing: habit.ongoing
          }))
      ];

      const { data: progressSettings, error: progressError } = await supabase.from("habits")
        .select("user_id, metric_progress_mode").eq("id", habitId).single();
      if (progressError) throw progressError;
      const progressUserId = progressSettings.metric_progress_mode === "shared"
        ? progressSettings.user_id : req.user.id;

      // Все исторические таймеры привычки
      const { data: timersData, error: timersError } = await supabase
        .from("habit_timers")
        .select("id, started_at, end_at, status, pauses, circles")
        .eq("habit_id", habitId)
        .eq("user_id", progressUserId)
        .order("started_at", { ascending: false });

      if (timersError) {
        console.log(timersError);
        return res.status(500).json({ success: false, error: "Ошибка при получении таймеров" });
      }
      const { data: countersData, error: countersError } = await supabase
        .from("habit_counters")
        .select("id, created_at, count, progression, min_count")
        .eq("habit_id", habitId)
        .eq("user_id", progressUserId)
        .order("created_at", { ascending: false });

      if (countersError) {
        console.log(countersError);
        return res.status(500).json({ success: false, error: "Ошибка при получении счётчиков" });
      }

      const parsedCounters = (countersData || []).map(c => ({
        id: c.id,
        started_at: new Date(c.created_at),
        count: Number(c.count),
        min_count: Number(c.min_count),
        progression: (c.progression || []).map(p => ({
          count: Number(p.count || 0),
          time: new Date(p.time),
          text: p.text || ""
        }))
      }));

      res.json({ 
        success: true, 
        calendar: mapped, 
        timers: timersData || [],
        counters: parsedCounters
      });
    } catch (err) {
      console.error("Ошибка запроса к Supabase:", err);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}