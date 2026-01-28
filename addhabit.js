import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
  app.post("/addhabit", authenticateUser(supabase), async (req, res) => {
    const { id } = req.user;

    const {
      name,
      desc,
      startDate,
      endDate,
      now,
      periodicity,
      chosenDays,
      start_time,
      end_time,
      tag
    } = req.body;

    const timeRegex = /^\d{2}:\d{2}$/;

    if (start_time && !timeRegex.test(start_time)) {
      return res.status(400).json({ error: "Некорректное start_time" });
    }
    if (end_time && !timeRegex.test(end_time)) {
      return res.status(400).json({ error: "Некорректное end_time" });
    }
    if (!name || !startDate || (!endDate && !now) || !periodicity) {
      return res.status(400).json({ error: "Недостаточно данных" });
    }
    if (periodicity === "weekly" && (!Array.isArray(chosenDays) || chosenDays.length === 0)) {
      return res.status(400).json({ error: "Для weekly нужно выбрать дни" });
    }
    if (now && endDate) {
      return res.status(400).json({ error: "Либо now, либо endDate" });
    }
    const ongoing = Boolean(now);

    const { data: habit, error:habitError } = await supabase.from("habits").insert({
      user_id: id,
      name,
      desc,
      periodicity,
      start_date: startDate,
      end_date: now ? null : endDate,
      ongoing: ongoing,
      chosen_days: chosenDays && chosenDays.length > 0 ? chosenDays : null,
      start_time,
      end_time,
      tag
    }).select("id")
      .single();    

    if (habitError) {
      console.error("Supabase insert error:", habitError);
      return res.status(500).json({ habitError: "Failed to add habit" });
    }

    const { settingsError } = await supabase.from("habits_settings").insert({
      habit_id: habit.id
    })

    if (settingsError) {
      console.error("Supabase settings insert error:", settingsError);
      return res.status(500).json({ settingsError: "Failed to setting habit" });
    }

    res.status(200).json({ success: true });
  });
}