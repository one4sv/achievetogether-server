import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
    app.get("/schedule", authenticateUser(supabase), async (req, res) => {
        const { id: user_id } = req.user;

        try {
            const { data: habits } = await supabase
                .from("habits")
                .select("id")
                .eq("user_id", user_id);

            if (!habits) {
                return res.json({ success:true, message:"nohabits" })
            }
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

    let message = "";

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

        // 3. Toggle записи в schedule_completions
        const { data: existing } = await supabase
            .from("schedule_completions")
            .select("id")
            .eq("habit_id", habitIdNum)
            .eq("schedule_id", blockIdNum)
            .eq("date", date)
            .single();

        if (existing) {
            const { error: deleteError } = await supabase
                .from("schedule_completions")
                .delete()
                .eq("id", existing.id);
            if (deleteError) throw deleteError;
            message = "Завершение блока удалено";
        } else {
            const { error: insertError } = await supabase
                .from("schedule_completions")
                .insert({
                    habit_id: habitIdNum,
                    schedule_id: blockIdNum,
                    date: date
                });
            if (insertError) throw insertError;
            message = "Завершение блока сохранено";
        }
        
        // === АВТО-ЗАВЕРШЕНИЕ ПРИВЫЧКИ ===
        const { data: habits_settings } = await supabase
            .from("habits_settings")
            .select("auto_schedule_completion")
            .eq("habit_id", habitIdNum)
            .single();

        const asc = habits_settings?.auto_schedule_completion || "none";

        if (asc === "none") {
            return res.json({ success: true, message });
        }

        const { data: schedule_settings } = await supabase
            .from("schedule_settings")
            .select("isSeparated")
            .eq("habit_id", habitIdNum)
            .single();

        const { data: schedule } = await supabase
            .from("schedule")
            .select("id, day_of_week, isSeparator")
            .eq("habit_id", habitIdNum);

        const { data: week_start } = await supabase
            .from("settings")
            .select("week_start")
            .eq("user_id", req.user.id)
            .single();

        const weekStart = new Date(week_start?.week_start || '2025-09-01');
        const targetDate = new Date(date);
        weekStart.setHours(0, 0, 0, 0);
        targetDate.setHours(0, 0, 0, 0);
        
        const diffDays = Math.floor((targetDate - weekStart) / (24 * 60 * 60 * 1000));
        const weekNumber = Math.floor(diffDays / 7);
        const isEvenWeek = weekNumber % 2 === 1;

        const dayOfWeek = targetDate.getDay(); // 0 = воскресенье
        
        const activeBlocks = (schedule || []).filter(b => {
            if (b.day_of_week !== dayOfWeek) return false;
            if (!schedule_settings?.isSeparated) return true;
            return b.isSeparator === isEvenWeek;
        });

        const { data: completedBlocks } = await supabase
            .from("schedule_completions")
            .select("schedule_id")
            .eq("habit_id", habitIdNum)
            .eq("date", date);

        const completedIds = new Set((completedBlocks || []).map(c => c.schedule_id));

        if (!existing) {
            completedIds.add(blockIdNum);
        } else {
            completedIds.delete(blockIdNum);
        }

        const completedCount = activeBlocks.filter(b => completedIds.has(b.id)).length;

        const shouldComplete = 
            (asc === 'all' && activeBlocks.length > 0 && completedCount === activeBlocks.length) ||
            (asc === 'one' && completedCount >= 1);

        const { data: habitCompletion, error: hcError } = await supabase
            .from("habit_completions")
            .select("id, is_user_marked")
            .eq("habit_id", habitIdNum)
            .eq("completed_at", date)
            .maybeSingle();

        if (hcError) throw hcError;

        console.log({
            activeBlocks: activeBlocks.length,
            completedCount,
            asc,
            shouldComplete,
            activeIds: activeBlocks.map(b => b.id),
            clicked: blockIdNum,
            isEvenWeek,
        });

        if (shouldComplete) {
            if (!habitCompletion) {
                await supabase.from("habit_completions").insert({
                    habit_id: habitIdNum,
                    completed_at: date,
                    user_id: req.user.id,
                    is_user_marked: false  // авто-создание
                });
            }
        } else {
            if (habitCompletion && !habitCompletion.is_user_marked) {
                await supabase
                    .from("habit_completions")
                    .delete()
                    .eq("id", habitCompletion.id);
            }
        }

        res.json({ success: true, message });

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