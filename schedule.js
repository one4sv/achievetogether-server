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

    app.post("/schedule/complete", authenticateUser(supabase), async (req, res) => {
        const { habit_id, blockId, date } = req.body;

        if (!habit_id || !blockId || !date) {
            return res.status(400).json({ 
                success: false, 
                error: "habit_id, blockId и date обязательны" 
            });
        }

        const habitIdNum = parseInt(habit_id, 10);
        const blockIdNum = parseInt(blockId, 10);

        if (isNaN(habitIdNum) || isNaN(blockIdNum)) {
            return res.status(400).json({ 
                success: false, 
                error: "habit_id и blockId должны быть числами" 
            });
        }

        const { data: settings } = await supabase
            .from("habits_settings")
            .select("auto_schedule_completion")
            .eq("habit_id", habitIdNum)
            .single();

        try {
            // 1. Проверяем права доступа к привычке
            const { data: habit, error: habitError } = await supabase
                .from("habits")
                .select("id")
                .eq("id", habitIdNum)
                .eq("user_id", req.user.id)
                .single();

            if (habitError || !habit) {
                return res.status(403).json({ 
                    success: false, 
                    error: "Нет доступа к привычке" 
                });
            }

            // 2. Проверяем, что блок принадлежит этой привычке
            const { data: block, error: blockError } = await supabase
                .from("schedule")
                .select("id")
                .eq("id", blockIdNum)
                .eq("habit_id", habitIdNum)
                .single();

            if (blockError || !block) {
                return res.status(404).json({ 
                    success: false, 
                    error: "Блок расписания не найден или не принадлежит привычке" 
                });
            }

            // 3. Проверяем, есть ли уже запись о завершении
            const { data: existing } = await supabase
                .from("schedule_completions")
                .select("id")
                .eq("habit_id", habitIdNum)
                .eq("schedule_id", blockIdNum)
                .eq("date", date)
                .single();

            let message = "";

            if (existing) {
                // === УДАЛЯЕМ ===
                const { error: deleteError } = await supabase
                    .from("schedule_completions")
                    .delete()
                    .eq("id", existing.id);

                if (deleteError) throw deleteError;
                message = "Завершение удалено (отмечено как невыполненное)";
            } else {
                // === ДОБАВЛЯЕМ ===
                const { error: insertError } = await supabase
                    .from("schedule_completions")
                    .insert({
                        habit_id: habitIdNum,
                        schedule_id: blockIdNum,
                        date: date
                    });

                if (insertError) throw insertError;
                message = "Завершение сохранено";
            }

            res.json({ 
                success: true, 
                message,
            });
        } catch (err) {
            console.error("Ошибка toggle завершения расписания:", err);
            res.status(500).json({ 
                success: false, 
                error: "Ошибка сервера при обработке завершения" 
            });
        }
    });

    app.get("/schedule/complete/:id", authenticateUser(supabase), async (req, res) => {
        const habitId = parseInt(req.params.id);
        if (isNaN(habitId)) {
            return res.status(400).json({ 
                success: false, 
                error: "Неверный ID привычки" 
            });
        }

        try {
            const { data: habit, error: habitError } = await supabase
                .from("habits")
                .select("id")
                .eq("id", habitId)
                .eq("user_id", req.user.id)
                .single();

            if (habitError || !habit) {
                return res.status(403).json({ 
                    success: false, 
                    error: "Нет доступа к привычке" 
                });
            }

            const { data: completions, error: completionsError } = await supabase
                .from("schedule_completions")
                .select(`
                    id,
                    habit_id,
                    schedule_id,
                    date,
                    created_at
                `)
                .eq("habit_id", habitId)
                .order("date", { ascending: true })
                .order("created_at", { ascending: true });

            if (completionsError) throw completionsError;

            res.json({
                success: true,
                completions: completions || []
            });
        } catch (err) {
            console.error("Ошибка получения завершений расписания:", err);
            res.status(500).json({ 
                success: false, 
                error: "Ошибка сервера при получении завершений" 
            });
        }
    });
}