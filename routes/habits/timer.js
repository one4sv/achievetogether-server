import { getHabitAccess, requireHabitPermission } from "../../utils/habitAccess.js";
import { canCompleteHabitDay, moscowDate } from "../../utils/habitCompletionDate.js";
import { authenticateUser } from "../../middleware/token.js"
import { broadcastTimerUpdate } from "../../realtime/ws.js"

export default function(app, supabase) {
    const canUseTimer = async (habitId, userId) => {
        const access = await getHabitAccess(supabase, habitId, userId);
        return !!access?.is_member && !!access.can_view;
    };
    const metricUser = async (habitId, userId) => {
        const { data: habit, error } = await supabase.from("habits")
            .select("user_id, metric_progress_mode").eq("id", habitId).maybeSingle();
        if (error || !habit) throw error || new Error("Activity not found");
        return habit.metric_progress_mode === "shared" ? habit.user_id : userId;
    };
    const notifyTimer = async (habitId, userId, timer) => {
        broadcastTimerUpdate(userId, habitId, timer);
        const { data: habit, error } = await supabase.from("habits")
            .select("user_id, metric_progress_mode, chat_id").eq("id", habitId).maybeSingle();
        if (error || habit?.metric_progress_mode !== "shared") return;
        const { data: members, error: memberError } = await supabase.from("habit_members")
            .select("user_id").eq("habit_id", habitId).eq("status", "accepted");
        if (memberError) return;
        const recipients = new Set([habit.user_id, ...(members || []).map(m => m.user_id)]);
        recipients.delete(userId);
        if (habit.chat_id) {
            const { data: blocked, error: blockedError } = await supabase.from("chat_members")
                .select("user_id").eq("chat_id", habit.chat_id).eq("is_blocked", true);
            if (blockedError) return;
            for (const item of blocked || []) recipients.delete(item.user_id);
        }
        for (const id of recipients) broadcastTimerUpdate(id, habitId, timer);
    };
    app.get("/timer/:habit_id", authenticateUser(supabase), async (req, res) => {
        const { id: userId } = req.user;
        const habitId = parseInt(req.params.habit_id);

        const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" });
        const startOfDay = new Date(`${today}T00:00:00+03:00`).toISOString();
        const endOfDay = new Date(new Date(startOfDay).getTime() + 24 * 60 * 60 * 1000).toISOString();

        try {
            if (!(await canUseTimer(habitId, userId))) return res.status(403).json({ success: false, error: "Нет доступа к таймеру" });
            const progressUserId = await metricUser(habitId, userId);
            const { data: habit, error: habitError } = await supabase
                .from("habits")
                .select("id")
                .eq("id", habitId)
                .single();

            if (habitError || !habit) {
                return res.status(404).json({ success: false, error: "Привычка не найдена или нет доступа" });
            }

            const { data: timerData, error: timerError } = await supabase
                .from("habit_timers")
                .select("id, started_at, end_at, status, pauses, circles")
                .eq("habit_id", habitId)
                .eq("user_id", progressUserId)
                .lte("started_at", endOfDay)
                .gte("end_at", startOfDay)
                .order("started_at", { ascending: false })
                .limit(1)
                .maybeSingle();

            if (timerError) {
                return res.status(500).json({ success: false, error: "Ошибка получения таймера" });
            }

            if (!timerData) {
                return res.json({ success: true, timer: null });
            }

            const timer = {
                id: timerData.id,
                started_at: timerData.started_at,
                end_at: timerData.end_at,
                status: timerData.status,
                pauses: timerData.pauses || [],
                circles: timerData.circles || []
            };

            res.json({ success: true, timer });
        } catch (err) {
            console.error("Ошибка при получении таймера:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });

    app.post("/timer/start", authenticateUser(supabase), requireHabitPermission(supabase, "complete"), async (req, res) => {
        const { id: userId } = req.user;
        const { habit_id: habitId, time, timer_id: timerId } = req.body;

        if (!habitId || !time) return res.status(400).json({ success: false, error: "Не указан ID привычки или время" });

        try {
            if (!(await canUseTimer(habitId, userId))) return res.status(403).json({ success: false, error: "Нет доступа к таймеру" });
            const progressUserId = await metricUser(habitId, userId);
            const startedAt = new Date(time);
            if (!canCompleteHabitDay(req.habitAccess, moscowDate(startedAt))) {
                return res.status(403).json({ success: false, error: "Дата таймера раньше вступления в беседу" });
            }
            const { data: habit } = await supabase.from("habits").select("id, end_time").eq("id", habitId).single();

            if (!habit) return res.status(404).json({ success: false, error: "Привычка не найдена" });

            let timerIdToUse = timerId;

            if (timerId) {
                // RESUME
                const { data: timerData } = await supabase.from("habit_timers").select("*").eq("id", timerId).eq("user_id", progressUserId).eq("habit_id", habitId).single();
                if (!timerData || timerData.status !== "paused") return res.status(400).json({ success: false, error: "Таймер не на паузе" });

                const pauses = [...(timerData.pauses || [])];
                const last = pauses.length - 1;
                if (last < 0 || pauses[last].end !== null) return res.status(400).json({ success: false, error: "Нет открытой паузы" });

                const pauseDuration = startedAt.getTime() - new Date(pauses[last].start).getTime();
                const newEndAt = new Date(new Date(timerData.end_at).getTime() + pauseDuration);

                pauses[last].end = startedAt.toISOString();

                await supabase.from("habit_timers").update({ status: "running", pauses, end_at: newEndAt.toISOString() }).eq("id", timerId).eq("user_id", progressUserId);
                timerIdToUse = timerId;
            } else {
                // NEW TIMER
                let endDate = new Date(startedAt);
                const [h, m] = (habit.end_time || "00:00").split(":").map(Number);
                endDate.setHours(h, m, 0, 0);
                if (endDate < startedAt) endDate.setDate(endDate.getDate() + 1);

                const { data: newTimer } = await supabase.from("habit_timers")
                    .insert({ habit_id: habitId, user_id: progressUserId, started_at: startedAt.toISOString(), end_at: endDate.toISOString(), status: "running", pauses: [], circles: [] })
                    .select("id").single();

                timerIdToUse = newTimer.id;
            }

            // Получаем актуальный таймер и отправляем broadcast
            const { data: updatedTimer } = await supabase
                .from("habit_timers")
                .select("id, started_at, end_at, status, pauses, circles")
                .eq("id", timerIdToUse).eq("user_id", progressUserId)
                .single();

            if (updatedTimer) void notifyTimer(habitId, userId, updatedTimer);

            res.json({ success: true, timer_id: timerIdToUse });
        } catch (err) {
            console.error(err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });

    app.post("/timer/pause", authenticateUser(supabase), requireHabitPermission(supabase, "complete"), async (req, res) => {
        const { id: userId } = req.user;
        const { habit_id: habitId, time, timer_id: timerId } = req.body;

        if (!habitId || !time || !timerId) return res.status(400).json({ success: false, error: "Недостаточно данных" });

        try {
            if (!(await canUseTimer(habitId, userId))) return res.status(403).json({ success: false, error: "Нет доступа к таймеру" });
            const progressUserId = await metricUser(habitId, userId);
            const pauseTime = new Date(time);
            const { data: timerData } = await supabase.from("habit_timers").select("*").eq("id", timerId).eq("user_id", progressUserId).eq("habit_id", habitId).single();

            if (!timerData || timerData.status !== "running") return res.status(400).json({ success: false, error: "Таймер не запущен" });

            const pauses = [...(timerData.pauses || [])];
            pauses.push({ start: pauseTime.toISOString(), time: time, end: null });

            await supabase.from("habit_timers").update({ status: "paused", pauses }).eq("id", timerId).eq("user_id", progressUserId);

            const { data: updatedTimer } = await supabase.from("habit_timers").select("id, started_at, end_at, status, pauses, circles").eq("id", timerId).eq("user_id", progressUserId).single();
            if (updatedTimer) void notifyTimer(habitId, userId, updatedTimer);

            res.json({ success: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });

    app.post("/timer/stop", authenticateUser(supabase), requireHabitPermission(supabase, "complete"), async (req, res) => {
        const { id: userId } = req.user;
        const { habit_id: habitId, time, timer_id: timerId } = req.body;

        if (!habitId || !time || !timerId) {
            return res.status(400).json({ success: false, error: "Не указан ID привычки, время или ID таймера" });
        }

        const stopTime = new Date(time);
        const todayMoscow = moscowDate(stopTime);
        if (!canCompleteHabitDay(req.habitAccess, todayMoscow)) {
            return res.status(403).json({ success: false, error: "Нельзя выполнить день до вступления в беседу" });
        }

        try {
            if (!(await canUseTimer(habitId, userId))) return res.status(403).json({ success: false, error: "Нет доступа к таймеру" });
            const progressUserId = await metricUser(habitId, userId);
            const completionUserId = (await getHabitAccess(supabase, habitId, userId)).completion_user_id;
            const { data: habit, error: habitError } = await supabase
                .from("habits")
                .select("id")
                .eq("id", habitId)
                .single();

            if (habitError || !habit) {
                return res.status(404).json({ success: false, error: "Привычка не найдена или нет доступа" });
            }

            const { data: timerData, error: timerError } = await supabase
                .from("habit_timers")
                .select("*")
                .eq("id", timerId).eq("user_id", progressUserId)
                .eq("habit_id", habitId)
                .single();

            if (timerError || !timerData) {
                return res.status(404).json({ success: false, error: "Таймер не найден" });
            }

            if (timerData.status !== "running" && timerData.status !== "paused") {
                return res.status(400).json({ success: false, error: "Таймер не активен" });
            }

            let pauses = timerData.pauses || [];
            if (timerData.status === "paused") {
                const lastPauseIndex = pauses.length - 1;
                if (lastPauseIndex >= 0 && pauses[lastPauseIndex].end === null) {
                    pauses[lastPauseIndex].end = stopTime.toISOString();
                }
            }

            const { error: updateError } = await supabase
                .from("habit_timers")
                .update({
                    status: "ended",
                    end_at: stopTime.toISOString(),
                    pauses
                })
                .eq("id", timerId).eq("user_id", progressUserId);

            if (updateError) {
                throw updateError;
            }

            const { data: existing } = await supabase
                .from("habit_completions")
                .select("id")
                .eq("habit_id", habitId)
                .eq("user_id", completionUserId)
                .eq("completed_at", todayMoscow);

                let completionId = null;

                if (!existing || existing.length === 0) {
                    const { data: insertData, error: insertError } = await supabase
                        .from("habit_completions")
                        .insert({
                            habit_id: habitId,
                            user_id: completionUserId,
                            completed_at: todayMoscow,
                            is_user_marked: false
                        })
                        .select("id")
                        .single();

                    if (insertError) {
                        console.error("Ошибка отметки выполненной привычки после stop:", insertError);
                    } else {
                        completionId = insertData.id;
                    }
                } else {
                    completionId = existing[0].id;
                }

                if (completionId) {
                    const { error: updateTimerError } = await supabase
                        .from("habit_timers")
                        .update({
                            done_id: completionId
                        })
                        .eq("id", timerId).eq("user_id", progressUserId);

                    if (updateTimerError) {
                        console.error("Ошибка обновления done_id в таймере:", updateTimerError);
                    }
                }

            const { data: updatedTimer, error: fetchError } = await supabase
                .from("habit_timers")
                .select("id, started_at, end_at, status, pauses, circles")
                .eq("id", timerId).eq("user_id", progressUserId)
                .single();

            if (!fetchError && updatedTimer) {
                void notifyTimer(habitId, userId, updatedTimer);
                res.json({ success: true, timer: updatedTimer });
            } else {
                res.json({ success: true });
            }
        } catch (err) {
            console.error("Ошибка при остановке таймера:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });

    app.post("/timer/circle", authenticateUser(supabase), requireHabitPermission(supabase, "complete"), async (req, res) => {
        const { id: userId } = req.user;
        const { habit_id: habitId, time, timer_id: timerId } = req.body;

        if (!habitId || !timerId || !time) {
            return res.status(400).json({ success: false, error: "Не указаны необходимые параметры" });
        }

        try {
            if (!(await canUseTimer(habitId, userId))) return res.status(403).json({ success: false, error: "Нет доступа к таймеру" });
            const progressUserId = await metricUser(habitId, userId);
            const { data: habit, error: habitError } = await supabase
                .from("habits")
                .select("id")
                .eq("id", habitId)
                .single();

            if (habitError || !habit) {
                return res.status(404).json({ success: false, error: "Привычка не найдена или нет доступа" });
            }

            const { data: timerData, error: timerError } = await supabase
                .from("habit_timers")
                .select("*")
                .eq("id", timerId).eq("user_id", progressUserId)
                .eq("habit_id", habitId)
                .single();

            if (timerError || !timerData) {
                return res.status(404).json({ success: false, error: "Таймер не найден" });
            }

            if (timerData.status !== "running") {
                return res.status(400).json({ success: false, error: "Таймер не запущен" });
            }

            const circles = timerData.circles || [];
            circles.push({ time: time, text: null });

            const { error: updateError } = await supabase
                .from("habit_timers")
                .update({ circles })
                .eq("id", timerId).eq("user_id", progressUserId);

            if (updateError) {
                throw updateError;
            }
            const { data: updatedTimer, error: fetchError } = await supabase
                .from("habit_timers")
                .select("id, started_at, end_at, status, pauses, circles")
                .eq("id", timerId).eq("user_id", progressUserId)
                .single();

            if (!fetchError && updatedTimer) {
                void notifyTimer(habitId, userId, updatedTimer);
                res.json({ success: true }); // возвращаем полный таймер
            } else {
            res.json({ success: true });
            }
        } catch (err) {
            console.error("Ошибка при добавлении circle:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });
    app.post("/timer/circle/text", authenticateUser(supabase), requireHabitPermission(supabase, "complete"), async (req, res) => {
        const { id: userId } = req.user;
        const { habit_id: habitId, timer_id: timerId, time, text } = req.body;

        if (!habitId || !timerId || !time) {
            return res.status(400).json({ success: false, error: "Не указаны необходимые параметры" });
        }

        try {
            if (!(await canUseTimer(habitId, userId))) return res.status(403).json({ success: false, error: "Нет доступа к таймеру" });
            const progressUserId = await metricUser(habitId, userId);
            const { data: habit, error: habitError } = await supabase
                .from("habits")
                .select("id")
                .eq("id", habitId)
                .single();

            if (habitError || !habit) {
                return res.status(404).json({ success: false, error: "Привычка не найдена или нет доступа" });
            }

            const { data: timerData, error: timerError } = await supabase
                .from("habit_timers")
                .select("*")
                .eq("id", timerId).eq("user_id", progressUserId)
                .eq("habit_id", habitId)
                .single();

            if (timerError || !timerData) {
                return res.status(404).json({ success: false, error: "Таймер не найден" });
            }

            const circles = timerData.circles || [];
            let updated = false;
            for (let c of circles) {
                if (c.time === time) {
                    c.text = text;
                    updated = true;
                    break;
                }
            }

            if (!updated) {
                return res.status(404).json({ success: false, error: "Круг с таким временем не найден" });
            }

            const { error: updateError } = await supabase
                .from("habit_timers")
                .update({ circles })
                .eq("id", timerId).eq("user_id", progressUserId);

            if (updateError) {
                throw updateError;
            }

            const { data: updatedTimer, error: fetchError } = await supabase
                .from("habit_timers")
                .select("id, started_at, end_at, status, pauses, circles")
                .eq("id", timerId).eq("user_id", progressUserId)
                .single();

            if (!fetchError && updatedTimer) {
                void notifyTimer(habitId, userId, updatedTimer);
                res.json({ success: true });
            } else {
            res.json({ success: true });
            }
        } catch (err) {
            console.error("Ошибка обновления текста круга:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });
}