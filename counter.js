import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {

  const getTodayRange = () => {
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Europe/Moscow"
    });

    const start = new Date(`${today}T00:00:00+03:00`).toISOString();
    const end = new Date(new Date(start).getTime() + 24 * 60 * 60 * 1000 - 1).toISOString();

    return { start, end };
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
        count: min_count,
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

  app.post("/counter/plus", authenticateUser(supabase), async (req, res) => {
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

      const newCount = Math.max(min_count, Number(counter.count) + val);

      const progressEntry = {
        count: val,
        time: new Date().toISOString(),
        text: ""
      };

      const newProgression = [...(counter.progression || []), progressEntry];

      const { error } = await supabase
        .from("habit_counters")
        .update({
          count: newCount,
          progression: newProgression
        })
        .eq("id", counter.id);

      if (error) throw error;

      res.json({ success: true });

    } catch (e) {
      console.error(e);
      res.status(500).json({ success: false });
    }
  });

  app.post("/counter/settings", authenticateUser(supabase), async (req, res) => {
    const { id: user_id } = req.user;
    const { habit_id, min_counter, redCounterLeft, redCounterRight } = req.body;

    if (!habit_id) return res.status(400).json({ success: false });

    try {
      const owner = await checkHabitOwner(habit_id, user_id);
      if (!owner) return res.status(403).json({ success: false });

      const payload = {};
      if (typeof min_counter === "number") payload.min_counter = min_counter;
      if (typeof redCounterLeft === "number") payload.red_count_left = redCounterLeft;
      if (typeof redCounterRight === "number") payload.red_count_right = redCounterRight;

      const { error } = await supabase
        .from("counter_settings")
        .upsert(
          {
            habit_id,
            ...payload
          },
          { onConflict: "habit_id" }
        );

      if (error) throw error;

      if (typeof min_counter === "number") {
        const todayCounter = await getTodayCounter(habit_id);

        if (todayCounter) {
          const newCount = Math.max(min_counter, Number(todayCounter.count));

          await supabase
            .from("habit_counters")
            .update({
              min_count: min_counter,
              count: newCount
            })
            .eq("id", todayCounter.id);
        }
      }

      res.json({ success: true });

    } catch (e) {
      console.error(e);
      res.status(500).json({ success: false });
    }
  });

}
