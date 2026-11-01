import { filterBlockedHabitMemberships, getHabitAccess, requireHabitPermission } from "../../utils/habitAccess.js";
import { authenticateUser } from "../../middleware/token.js";
import { isCalendarDate } from "../../utils/validation.js";
import { isEvenScheduleWeek } from "../../utils/scheduleWeek.js";

export default function (app, supabase) {
    const habitAccess = async (habitId, userId) => {
        const access = await getHabitAccess(supabase, habitId, userId);
        return access?.can_view ? { ...access, isOwner: access.is_owner } : null;
    };
    const blockUserId = (access, userId) =>
        access.habit.schedule_blocks_mode === "personal" ? userId : access.habit.user_id;

    app.get("/schedule", authenticateUser(supabase), async (req, res) => {
        const { id: user_id } = req.user;

        try {
            const { data: memberships, error: membershipError } = await supabase.from("habit_members")
                .select("habit_id").eq("user_id", user_id).eq("status", "accepted");
            if (membershipError) throw membershipError;
            const sharedIds = (memberships || []).map(m => m.habit_id);
            const { data: habitsRaw, error: habitError } = await supabase
                .from("habits")
                .select("id, user_id, schedule_blocks_mode")
                .or(`user_id.eq.${user_id}${sharedIds.length ? `,id.in.(${sharedIds.join(",")})` : ""}`);
            if (habitError) throw habitError;

            const habits = await filterBlockedHabitMemberships(supabase, habitsRaw, user_id);
            const habitIds = habits.map(h => h.id);
            if (!habitIds.length) return res.json({ success: true, schedules: {}, settings: {} });

            const { data: scheduleBlocks, error: scheduleError } = await supabase
                .from("schedule")
                .select(`
                    id,
                    habit_id,
                    user_id,
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

            const schedules = (scheduleBlocks || []).filter(b => {
                const habit = habits.find(h => h.id === b.habit_id);
                return habit && b.user_id === (habit.schedule_blocks_mode === "personal" ? user_id : habit.user_id);
            }).reduce((acc, b) => {
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
            const access = await habitAccess(habitId, req.user.id);
            if (!access) return res.status(403).json({ success: false, error: "Нет доступа к активности" });

            const { data: blocks, error } = await supabase
                .from("schedule")
                .select("id, day_of_week, isSeparator, name, start_time, end_time, created_by")
                .eq("habit_id", habitId)
                .eq("user_id", blockUserId(access, req.user.id))
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

    app.post("/schedule", authenticateUser(supabase), requireHabitPermission(supabase, "edit_blocks"), async (req, res) => {
        const { habit_id, blocks, isSeparated } = req.body;

        if (!habit_id || !Array.isArray(blocks)) {
            return res.status(400).json({ success: false, error: "habit_id и blocks обязательны" });
        }

        try {
            const access = await habitAccess(habit_id, req.user.id);
            if (!access) return res.status(403).json({ success: false, error: "Нет доступа к активности" });
            if (!access.isOwner && access.habit.schedule_blocks_mode === "shared" && !access.can_edit_blocks) {
                return res.status(403).json({ success: false, error: "Нет прав изменять общие блоки" });
            }
            const editorId = blockUserId(access, req.user.id);
            if (access.isOwner && typeof isSeparated === "boolean") {
                const { error } = await supabase.from("schedule_settings")
                    .upsert({ habit_id, isSeparated }, { onConflict: "habit_id" });
                if (error) throw error;
            }
            for (const block of blocks) {
                const name = typeof block.name === "string" ? block.name.trim() : "";
                if (block.id && !name) {
                    const { error } = await supabase.from("schedule").delete()
                        .eq("id", block.id).eq("habit_id", habit_id).eq("user_id", editorId);
                    if (error) throw error;
                    continue;
                }
                const payload = {
                    day_of_week: block.day_of_week,
                    isSeparator: block.isSeparator,
                    name,
                    start_time: block.start_time || null,
                    end_time: block.end_time || null
                };
                if (block.id !== 0) {
                    const { error } = await supabase.from("schedule").update(payload)
                        .eq("id", block.id).eq("habit_id", habit_id).eq("user_id", editorId);
                    if (error) throw error;
                } else if (name) {
                    const { error } = await supabase.from("schedule")
                        .insert([{ habit_id, user_id: editorId, created_by: req.user.id, ...payload }]);
                    if (error) throw error;
                }
            }

            res.json({ success: true, message: "Расписание сохранено" });
        } catch (err) {
            console.error(err);
            res.status(500).json({ success: false, error: "Ошибка сохранения" });
        }
    });

    app.post("/schedule/complete", authenticateUser(supabase), requireHabitPermission(supabase, "complete"), async (req, res) => {
        const { habit_id, blockId, date } = req.body;
        if (!isCalendarDate(date)) return res.status(400).json({ success: false, error: "Некорректная дата" });

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
            const access = await habitAccess(habitIdNum, req.user.id);
            if (!access) return res.status(403).json({ success: false, error: "Нет доступа к активности" });

            // 2. Проверяем, что блок принадлежит этой привычке
            const { data: block, error: blockError } = await supabase
                .from("schedule")
                .select("id")
                .eq("id", blockIdNum)
                .eq("habit_id", habitIdNum)
                .eq("user_id", blockUserId(access, req.user.id))
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
                .eq("user_id", access.progress_user_id)
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
                        user_id: access.progress_user_id,
                        actor_user_id: req.user.id,
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
                .eq("habit_id", habitIdNum)
                .eq("user_id", blockUserId(access, req.user.id));

            const { data: week_start } = await supabase
                .from("settings")
                .select("week_start")
                .eq("user_id", access.progress_user_id)
                .single();

            const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();

            const activeBlocks = (schedule || []).filter(b => {
                if (b.day_of_week !== dayOfWeek) return false;
                if (!schedule_settings?.isSeparated) return true;
                return Boolean(b.isSeparator) === isEvenScheduleWeek(week_start?.week_start, date);
            });

            const { data: completedBlocks } = await supabase
                .from("schedule_completions")
                .select("schedule_id")
                .eq("habit_id", habitIdNum)
                .eq("user_id", access.progress_user_id)
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
                .eq("user_id", access.progress_user_id)
                .eq("completed_at", date)
                .maybeSingle();

            if (hcError) throw hcError;


            if (shouldComplete) {
                if (!habitCompletion) {
                    await supabase.from("habit_completions").insert({
                        habit_id: habitIdNum,
                        completed_at: date,
                        user_id: access.progress_user_id,
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
            const access = await habitAccess(habitId, req.user.id);
            if (!access) return res.status(403).json({ success: false, error: "Нет доступа к активности" });

            const { data: completions, error: completionsError } = await supabase
                .from("schedule_completions")
                .select(`
                    id,
                    habit_id,
                    schedule_id,
                    date,
                    created_at,
                    actor_user_id
                `)
                .eq("habit_id", habitId)
                .eq("user_id", access.progress_user_id)
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
