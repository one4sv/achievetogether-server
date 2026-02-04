import { authenticateUser } from "./middleware/token.js";

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
    const { data, error } = await supabase
      .from("habits")
      .select("id")
      .eq("id", habit_id)
      .eq("user_id", user_id)
      .single();

    return !error && data;
  };

  const getTodayCounter = async (habit_id) => {
    const { start, end } = getTodayRange();

    const { data } = await supabase
      .from("habit_counters")
      .select("*")
      .eq("habit_id", habit_id)
      .gte("created_at", start)
      .lt("created_at", end)
      .maybeSingle();

    return data;
  };

  const createTodayCounter = async (habit_id, min_count) => {
    const { data, error } = await supabase
      .from("habit_counters")
      .insert({
        habit_id,
        count: 0,
        progression: [],
        min_count
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  };

  const getOrCreateTodayCounter = async (habit_id, min_count) => {
    const existing = await getTodayCounter(habit_id);
    if (existing) return existing;
    return await createTodayCounter(habit_id, min_count);
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

    if (!old_state && new_state) {
      // Добавляем completion
      const { error } = await supabase
        .from("habit_completions")
        .insert({
          habit_id,
          completed_at: today,
          user_id
        });

      if (error) throw error;
    } else if (old_state && !new_state) {
      // Удаляем completion
      const { error } = await supabase
        .from("habit_completions")
        .delete()
        .eq("habit_id", habit_id)
        .eq("completed_at", today);

      if (error) throw error;
    }
  };

  app.post("/counter/value", authenticateUser(supabase), async (req, res) => {
    const { id: user_id } = req.user;
    const { habit_id, val } = req.body;

    if (!habit_id || typeof val !== "number" || val === 0) {
      return res.status(400).json({ success: false });
    }

    try {
      const owner = await checkHabitOwner(habit_id, user_id);
      if (!owner) return res.status(403).json({ success: false });

      const min_count = await getMinCount(habit_id);
      const counter = await getOrCreateTodayCounter(habit_id, min_count);

      const oldCount = Number(counter.count);
      const newCount = Math.max(0, oldCount + val);

      const old_state = oldCount >= min_count;
      const new_state = newCount >= min_count;

      const progressEntry = {
        count: val,
        time: new Date().toISOString(),
        text: ""
      };

      const newProgression = [...(counter.progression || []), progressEntry];

      const { error: updateError } = await supabase
        .from("habit_counters")
        .update({
          count: newCount,
          progression: newProgression
        })
        .eq("id", counter.id);

      if (updateError) throw updateError;

      // Обновляем completion
      await checkAndUpdateCompletion(habit_id, user_id, old_state, new_state);

      res.json({ success: true });

    } catch (e) {
      console.error(e);
      res.status(500).json({ success: false });
    }
  });

  app.post("/counter/restore", authenticateUser(supabase), async (req, res) => {
    const { id: user_id } = req.user;
    const { habit_id } = req.body;

    if (!habit_id) return res.status(400).json({ success: false });

    try {
      const owner = await checkHabitOwner(habit_id, user_id);
      if (!owner) return res.status(403).json({ success: false });

      const min_count = await getMinCount(habit_id);
      const counter = await getOrCreateTodayCounter(habit_id, min_count);

      const oldCount = Number(counter.count);
      const delta = 0 - oldCount;

      let newProgression = [...(counter.progression || [])];

      if (delta !== 0) {
        newProgression.push({
          count: delta,
          time: new Date().toISOString(),
          text: "Сброс"
        });
      }

      const old_state = oldCount >= min_count;
      const new_state = 0 >= min_count;  // Обычно false, если min_count > 0

      const { error: updateError } = await supabase
        .from("habit_counters")
        .update({
          count: 0,
          progression: newProgression
        })
        .eq("id", counter.id);

      if (updateError) throw updateError;

      // Обновляем completion
      await checkAndUpdateCompletion(habit_id, user_id, old_state, new_state);

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
      const owner = await checkHabitOwner(habit_id, user_id);
      if (!owner) return res.status(403).json({ success: false });

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
        const todayCounter = await getTodayCounter(habit_id);

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

}