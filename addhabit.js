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

    if (!name || !startDate || (!endDate && !now) || !periodicity) {
      return res.status(400).json({ error: "Недостаточно данных" });
    }

    const { error } = await supabase.from("habits").insert({
      user_id: id,
      name,
      desc,
      periodicity,
      start_date: startDate,
      end_date: now ? null : endDate,
      ongoing: now || false,
      chosen_days: chosenDays && chosenDays.length > 0 ? chosenDays : null,
      start_time,
      end_time,
      tag
    });

    if (error) {
      console.error("Supabase insert error:", error);
      return res.status(500).json({ error: "Failed to add habit" });
    }

    res.status(200).json({ success: true });
  });
}