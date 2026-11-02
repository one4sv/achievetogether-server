import { getHabitAccess, requireHabitPermission } from "../../utils/habitAccess.js";
import { authenticateUser } from "../../middleware/token.js";

export default function (app, supabase) {

  const getTodayRange = () => {
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Europe/Moscow"
    });

    const start = new Date(`${today}T00:00:00+03:00`).toISOString();
    const end = new Date(new Date(start).getTime() + 24 * 60 * 60 * 1000 - 1).toISOString();

    return { start, end, today };  // Добавил today для completed_at
  };

  const getTodayDate = () => {
    return getTodayRange().today;  // 'YYYY-MM-DD'
  };

  const checkHabitOwner = async (habit_id, user_id) => {
    const access = await getHabitAccess(supabase, habit_id, user_id);
    return !!access?.is_member && !!access.can_view;
  };

  const metricUser = async (habit_id, user_id) => {
    const { data: habit, error } = await supabase.from("habits")
      .select("user_id, metric_progress_mode").eq("id", habit_id).maybeSingle();
    if (error || !habit) throw error || new Error("Activity not found");
    return habit.metric_progress_mode === "shared" ? habit.user_id : user_id;
  };

  const getTodayCounter = async (habit_id, user_id) => {
    const { start, end } = getTodayRange();
    const progressUserId = await metricUser(habit_id, user_id);

    const { data } = await supabase
      .from("habit_counters")
      .select("*")
      .eq("habit_id", habit_id)
      .eq("user_id", progressUserId)
      .gte("created_at", start)
      .lt("created_at", end)
      .maybeSingle();

    return data;
  };

  const createTodayCounter = async (habit_id, min_count, user_id) => {
    const progressUserId = await metricUser(habit_id, user_id);
    const { data, error } = await supabase
      .from("habit_counters")
      .insert({
        habit_id,
        user_id: progressUserId,
        count: 0,
        progression: [],
        min_count
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  };

  const getOrCreateTodayCounter = async (habit_id, min_count, user_id) => {
    const existing = await getTodayCounter(habit_id, user_id);
    if (existing) return existing;
    return await createTodayCounter(habit_id, min_count, user_id);
  };

  const getMinCount = async (habit_id) => {
    const { data } = await supabase
      .from("counter_settings")
      .select("min_counter")
      .eq("habit_id", habit_id)
      .maybeSingle();

    return data?.min_counter ?? 0;
  };

  // Helper для обновления completion
  const checkAndUpdateCompletion = async (habit_id, user_id, old_state, new_state) => {
    const today = getTodayDate();
    const completionUserId = (await getHabitAccess(supabase, habit_id, user_id)).completion_user_id;

    if (!old_state && new_state) {
      // Добавляем completion
      const { error } = await supabase
        .from("habit_completions")
        .insert({
          habit_id,
          completed_at: today,
          user_id: completionUserId
        });

      if (error) throw error;
    } else if (old_state && !new_state) {
      // Удаляем completion
      const { error } = await supabase
        .from("habit_completions")
        .delete()
        .eq("habit_id", habit_id)
        .eq("user_id", completionUserId)
        .eq("completed_at", today);

      if (error) throw error;
    }
  };
  app.get("/counter/:habit_id", authenticateUser(supabase), async (req, res) => {
    const { id: user_id } = req.user;
    const { habit_id } = req.params;

    try {
      const owner = await checkHabitOwner(habit_id, user_id);
      if (!owner) return res.status(403).json({ success: false });

      const counter = await getTodayCounter(habit_id, user_id);

      res.json({ success: true, counter });

    } catch (e) {
      console.error(e);
      res.status(500).json({ success: false });
    }
  });

  app.post("/counter/value", authenticateUser(supabase), requireHabitPermission(supabase, "complete"), async (req, res) => {
    const { id: user_id } = req.user;
    const { habit_id, val } = req.body;

    if (!habit_id || typeof val !== "number" || val === 0) {
      return res.status(400).json({ success: false });
    }

    try {
      const owner = await checkHabitOwner(habit_id, user_id);
      if (!owner) return res.status(403).json({ success: false });

      const { data, error } = await supabase.rpc("change_habit_counter", {
        p_habit_id: Number(habit_id), p_actor: user_id, p_delta: val, p_reset: false
      });
      if (error) throw error;

      res.json({ success: true });

    } catch (e) {
      console.error(e);
      res.status(500).json({ success: false });
    }
  });

  app.post("/counter/restore", authenticateUser(supabase), requireHabitPermission(supabase, "complete"), async (req, res) => {
    const { id: user_id } = req.user;
    const { habit_id } = req.body;

    if (!habit_id) return res.status(400).json({ success: false });

    try {
      const owner = await checkHabitOwner(habit_id, user_id);
      if (!owner) return res.status(403).json({ success: false });

      const { error } = await supabase.rpc("change_habit_counter", {
        p_habit_id: Number(habit_id), p_actor: user_id, p_delta: 0, p_reset: true
      });
      if (error) throw error;

      res.json({ success: true });

    } catch (e) {
      console.error(e);
      res.status(500).json({ success: false });
    }
  });

  app.post("/counter/settings", authenticateUser(supabase), async (req, res) => {
    const { id: user_id } = req.user;
    const { habit_id, min_counter, red_counter_left, red_counter_right } = req.body;

    if (!habit_id) return res.status(400).json({ success: false });

    try {
      const { data: ownedHabit } = await supabase.from("habits").select("id").eq("id", habit_id).eq("user_id", user_id).maybeSingle();
      if (!ownedHabit) return res.status(403).json({ success: false });

      const payload = {};
      if (typeof min_counter === "number") payload.min_counter = min_counter;
      if (typeof red_counter_left === "number") payload.red_counter_left = red_counter_left;
      if (typeof red_counter_right === "number") payload.red_counter_right = red_counter_right;

      if (Object.keys(payload).length === 0) return res.status(400).json({ success: false });

      const { data: existing } = await supabase
        .from("counter_settings")
        .select("habit_id")
        .eq("habit_id", habit_id)
        .maybeSingle();

      if (existing) {
        const { error } = await supabase
          .from("counter_settings")
          .update(payload)
          .eq("habit_id", habit_id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("counter_settings")
          .insert({
            habit_id,
            ...payload
          });
        if (error) throw error;
      }

      if (typeof min_counter === "number") {
        const todayCounter = await getTodayCounter(habit_id, user_id);

        if (todayCounter) {
          const old_min = todayCounter.min_count;
          const current_count = todayCounter.count;

          const old_state = current_count >= old_min;
          const new_state = current_count >= min_counter;

          const { error: updateError } = await supabase
            .from("habit_counters")
            .update({
              min_count: min_counter,
            })
            .eq("id", todayCounter.id);

          if (updateError) throw updateError;

          // Обновляем completion
          await checkAndUpdateCompletion(habit_id, user_id, old_state, new_state);
        }
      }

      res.json({ success: true });

    } catch (e) {
      console.error(e);
      res.status(500).json({ success: false });
    }
  });
  app.post("/counter/text", authenticateUser(supabase), requireHabitPermission(supabase, "complete"), async (req, res) => {
    const { id: user_id } = req.user;
    const { habit_id, counter_id, time, text } = req.body;

    if (!habit_id || !counter_id || !time) {
      return res.status(400).json({ success: false });
    }

    try {
      const owner = await checkHabitOwner(habit_id, user_id);
      if (!owner) return res.status(403).json({ success: false });

      const counter = await getTodayCounter(habit_id, user_id);
      if (!counter) return res.status(404).json({ success: false });

      const progression = counter.progression || [];

      const newProgression = progression.map((p) => {
        if (new Date(p.time).toISOString() === new Date(time).toISOString()) {
          return {
            ...p,
            text: text || ""
          };
        }
        return p;
      });

      const { error } = await supabase
        .from("habit_counters")
        .update({ progression: newProgression })
        .eq("id", counter.id);

      if (error) throw error;

      res.json({ success: true });

    } catch (e) {
      console.error(e);
      res.status(500).json({ success: false });
    }
  });

}