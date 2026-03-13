import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
    app.get("/schedule", authenticateUser(supabase), async (req, res) => {
        const { id: user_id } = req.user;

        try {
            const { data: habits } = await supabase
                .from("habits")
                .select("id")
                .eq("user_id", user_id);

            const habitIds = habits.map(h => h.id);

            const { data: scheduleBlocks, error: scheduleError } = await supabase
                .from("schedule")
                .select(`
                    id,
                    habit_id,
                    day_of_week,
                    "isSeparator",
                    name,
                    start_time,
                    end_time
                `)
                .in("habit_id", habitIds);

            if (scheduleError) throw scheduleError;

            const { data: settingsData, error: settingsError } = await supabase
                .from("schedule_settings")
                .select("habit_id, color, isSeparated")
                .in("habit_id", habitIds);

            if (settingsError) throw settingsError;

            const schedules = (scheduleBlocks || []).reduce((acc, b) => {
                const hid = String(b.habit_id);
                if (!acc[hid]) acc[hid] = [];

                acc[hid].push({
                    id: b.id,
                    day_of_week: Number(b.day_of_week),
                    isSeparator: Boolean(b.isSeparator),
                    name: b.name || "",
                    start_time: b.start_time || "",
                    end_time: b.end_time || ""
                });

                return acc;
            }, {});

            const settings = (settingsData || []).reduce((acc, s) => {
                acc[String(s.habit_id)] = {
                    habit_id:s.habit_id,
                    color: s.color,
                    isSeparated: s.isSeparated
                };
                return acc;
            }, {});

            for (const h of habitIds) {
                const key = String(h);

                if (!schedules[key]) schedules[key] = [];
                if (!settings[key]) settings[key] = null;
            }

            res.json({
                success: true,
                schedules,
                settings
            });

        } catch (err) {
            console.error(err);
            res.status(500).json({
                success: false,
                error: "Ошибка получения общего расписания"
            });
        }
    });

    app.get("/schedule/:id", authenticateUser(supabase), async (req, res) => {
        const habitId = parseInt(req.params.id);
        if (isNaN(habitId)) return res.status(400).json({ success: false, error: "Неверный ID привычки" });

        try {
            const { data: habit, error: habitError } = await supabase
                .from("habits")
                .select("id")
                .eq("id", habitId)
                .single();

            if (habitError || !habit) {
                return res.status(habitError ? 500 : 404).json({ success: false, error: habitError ? "Ошибка БД" : "Привычка не найдена" });
            }

            const { data: blocks, error } = await supabase
                .from("schedule")
                .select("id, day_of_week, isSeparator, name, start_time, end_time")
                .eq("habit_id", habitId)
                .order("day_of_week")
                .order("created_at");

            const { data:settings} = await supabase
                .from("schedule_settings")
                .select("habit_id, color, isSeparated")
                .eq("habit_id", habitId)
                .single()

            if (error) throw error;

            res.json({
                success: true,
                blocks: (blocks ?? []).map(b => ({
                    id: b.id,
                    day_of_week: Number(b.day_of_week),
                    isSeparator: Boolean(b.isSeparator),
                    name: b.name || "",
                    start_time: b.start_time || "",
                    end_time: b.end_time || ""
                })),
                settings:settings ?? null,
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });

    app.post("/schedule", authenticateUser(supabase), async (req, res) => {
        const { habit_id, blocks, isSeparated } = req.body;

        if (!habit_id || !Array.isArray(blocks)) {
            return res.status(400).json({ success: false, error: "habit_id и blocks обязательны" });
        }

        try {
            await supabase
                .from("schedule_settings")
                .upsert({
                    habit_id,
                    isSeparated
                }, {
                    onConflict: "habit_id"
                });
                
            const { data: habit } = await supabase
                .from("habits")
                .select("id")
                .eq("id", habit_id)
                .eq("user_id", req.user.id)
                .single();

            if (!habit) return res.status(403).json({ success: false, error: "Нет доступа к привычке" });

            for (const block of blocks) {
                if (block.id && !block.name.trim()) {
                    await supabase
                        .from("schedule")
                        .delete()
                        .eq("id", block.id)

                    continue
                }

                if (block.id !== 0) {
                    await supabase
                        .from("schedule")
                        .update({
                            day_of_week: block.day_of_week,
                            isSeparator: block.isSeparator,
                            name: block.name.trim(),
                            start_time: block.start_time || null,
                            end_time: block.end_time || null
                        })
                        .eq("id", block.id)

                } else if (block.name.trim()) {

                    await supabase
                        .from("schedule")
                        .insert([{
                            habit_id,
                            day_of_week: block.day_of_week,
                            isSeparator: block.isSeparator,
                            name: block.name.trim(),
                            start_time: block.start_time || null,
                            end_time: block.end_time || null
                        }]);
                }
            }

            res.json({ success: true, message: "Расписание сохранено" });
        } catch (err) {
            console.error(err);
            res.status(500).json({ success: false, error: "Ошибка сохранения" });
        }
    });
}