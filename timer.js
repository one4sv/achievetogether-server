import { authenticateUser } from "./middleware/token.js"
import { broadcastTimerUpdate } from "./ws.js"

export default function(app, supabase) {
    app.get("/timer/:habit_id", authenticateUser(supabase), async (req, res) => {
        const { id: userId } = req.user;
        const habitId = parseInt(req.params.habit_id);

        const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" });
        const startOfDay = new Date(`${today}T00:00:00+03:00`).toISOString();
        const endOfDay = new Date(new Date(startOfDay).getTime() + 24 * 60 * 60 * 1000).toISOString();

        try {
            const { data: habit, error: habitError } = await supabase
                .from("habits")
                .select("id")
                .eq("id", habitId)
                .eq("user_id", userId)
                .single();

            if (habitError || !habit) {
                return res.status(404).json({ success: false, error: "Привычка не найдена или нет доступа" });
            }

            const { data: timerData, error: timerError } = await supabase
                .from("habit_timers")
                .select("id, started_at, end_at, status, pauses, circles")
                .eq("habit_id", habitId)
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

    app.post("/timer/start", authenticateUser(supabase), async (req, res) => {
        const { id: userId } = req.user;
        const { habit_id: habitId, time, timer_id: timerId } = req.body;

        if (!habitId || !time) return res.status(400).json({ success: false, error: "Не указан ID привычки или время" });

        try {
            const startedAt = new Date(time);
            const { data: habit } = await supabase.from("habits").select("id, end_time").eq("id", habitId).eq("user_id", userId).single();

            if (!habit) return res.status(404).json({ success: false, error: "Привычка не найдена" });

            let timerIdToUse = timerId;

            if (timerId) {
                // RESUME
                const { data: timerData } = await supabase.from("habit_timers").select("*").eq("id", timerId).eq("habit_id", habitId).single();
                if (!timerData || timerData.status !== "paused") return res.status(400).json({ success: false, error: "Таймер не на паузе" });

                const pauses = [...(timerData.pauses || [])];
                const last = pauses.length - 1;
                if (last < 0 || pauses[last].end !== null) return res.status(400).json({ success: false, error: "Нет открытой паузы" });

                const pauseDuration = startedAt.getTime() - new Date(pauses[last].start).getTime();
                const newEndAt = new Date(new Date(timerData.end_at).getTime() + pauseDuration);

                pauses[last].end = startedAt.toISOString();

                await supabase.from("habit_timers").update({ status: "running", pauses, end_at: newEndAt.toISOString() }).eq("id", timerId);
                timerIdToUse = timerId;
            } else {
                // NEW TIMER
                let endDate = new Date(startedAt);
                const [h, m] = (habit.end_time || "00:00").split(":").map(Number);
                endDate.setHours(h, m, 0, 0);
                if (endDate < startedAt) endDate.setDate(endDate.getDate() + 1);

                const { data: newTimer } = await supabase.from("habit_timers")
                    .insert({ habit_id: habitId, started_at: startedAt.toISOString(), end_at: endDate.toISOString(), status: "running", pauses: [], circles: [] })
                    .select("id").single();

                timerIdToUse = newTimer.id;
            }

            // Получаем актуальный таймер и отправляем broadcast
            const { data: updatedTimer } = await supabase
                .from("habit_timers")
                .select("id, started_at, end_at, status, pauses, circles")
                .eq("id", timerIdToUse)
                .single();

            if (updatedTimer) broadcastTimerUpdate(userId, habitId, updatedTimer);

            res.json({ success: true, timer_id: timerIdToUse });
        } catch (err) {
            console.error(err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });

    app.post("/timer/pause", authenticateUser(supabase), async (req, res) => {
        const { id: userId } = req.user;
        const { habit_id: habitId, time, timer_id: timerId } = req.body;

        if (!habitId || !time || !timerId) return res.status(400).json({ success: false, error: "Недостаточно данных" });

        try {
            const pauseTime = new Date(time);
            const { data: timerData } = await supabase.from("habit_timers").select("*").eq("id", timerId).eq("habit_id", habitId).single();

            if (!timerData || timerData.status !== "running") return res.status(400).json({ success: false, error: "Таймер не запущен" });

            const pauses = [...(timerData.pauses || [])];
            pauses.push({ start: pauseTime.toISOString(), time: time, end: null });

            await supabase.from("habit_timers").update({ status: "paused", pauses }).eq("id", timerId);

            const { data: updatedTimer } = await supabase.from("habit_timers").select("id, started_at, end_at, status, pauses, circles").eq("id", timerId).single();
            if (updatedTimer) broadcastTimerUpdate(userId, habitId, updatedTimer);

            res.json({ success: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });

    app.post("/timer/stop", authenticateUser(supabase), async (req, res) => {
        const { id: userId } = req.user;
        const { habit_id: habitId, time, timer_id: timerId } = req.body;

        if (!habitId || !time || !timerId) {
            return res.status(400).json({ success: false, error: "Не указан ID привычки, время или ID таймера" });
        }

        const stopTime = new Date(time);
        const todayMoscow = stopTime.toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" });

        try {
            const { data: habit, error: habitError } = await supabase
                .from("habits")
                .select("id")
                .eq("id", habitId)
                .eq("user_id", userId)
                .single();

            if (habitError || !habit) {
                return res.status(404).json({ success: false, error: "Привычка не найдена или нет доступа" });
            }

            const { data: timerData, error: timerError } = await supabase
                .from("habit_timers")
                .select("*")
                .eq("id", timerId)
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
                .eq("id", timerId);

            if (updateError) {
                throw updateError;
            }

            const { data: existing } = await supabase
                .from("habit_completions")
                .select("id")
                .eq("habit_id", habitId)
                .eq("user_id", userId)
                .eq("completed_at", todayMoscow);

                let completionId = null;

                if (!existing || existing.length === 0) {
                    const { data: insertData, error: insertError } = await supabase
                        .from("habit_completions")
                        .insert({
                            habit_id: habitId,
                            user_id: userId,
                            completed_at: todayMoscow
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
                        .eq("id", timerId);

                    if (updateTimerError) {
                        console.error("Ошибка обновления done_id в таймере:", updateTimerError);
                    }
                }

            const { data: updatedTimer, error: fetchError } = await supabase
                .from("habit_timers")
                .select("id, started_at, end_at, status, pauses, circles")
                .eq("id", timerId)
                .single();

            if (!fetchError && updatedTimer) {
                broadcastTimerUpdate(userId, habitId, updatedTimer);
                res.json({ success: true, timer: updatedTimer });
            } else {
                res.json({ success: true });
            }
        } catch (err) {
            console.error("Ошибка при остановке таймера:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });

    app.post("/timer/circle", authenticateUser(supabase), async (req, res) => {
        const { id: userId } = req.user;
        const { habit_id: habitId, time, timer_id: timerId } = req.body;

        if (!habitId || !timerId || !time) {
            return res.status(400).json({ success: false, error: "Не указаны необходимые параметры" });
        }

        try {
            const { data: habit, error: habitError } = await supabase
                .from("habits")
                .select("id")
                .eq("id", habitId)
                .eq("user_id", userId)
                .single();

            if (habitError || !habit) {
                return res.status(404).json({ success: false, error: "Привычка не найдена или нет доступа" });
            }

            const { data: timerData, error: timerError } = await supabase
                .from("habit_timers")
                .select("*")
                .eq("id", timerId)
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
                .eq("id", timerId);

            if (updateError) {
                throw updateError;
            }
            const { data: updatedTimer, error: fetchError } = await supabase
                .from("habit_timers")
                .select("id, started_at, end_at, status, pauses, circles")
                .eq("id", timerId)
                .single();

            if (!fetchError && updatedTimer) {
                broadcastTimerUpdate(userId, habitId, updatedTimer);
                res.json({ success: true }); // возвращаем полный таймер
            } else {
            res.json({ success: true });
            }
        } catch (err) {
            console.error("Ошибка при добавлении circle:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });
    app.post("/timer/circle/text", authenticateUser(supabase), async (req, res) => {
        const { id: userId } = req.user;
        const { habit_id: habitId, timer_id: timerId, time, text } = req.body;

        if (!habitId || !timerId || !time) {
            return res.status(400).json({ success: false, error: "Не указаны необходимые параметры" });
        }

        try {
            const { data: habit, error: habitError } = await supabase
                .from("habits")
                .select("id")
                .eq("id", habitId)
                .eq("user_id", userId)
                .single();

            if (habitError || !habit) {
                return res.status(404).json({ success: false, error: "Привычка не найдена или нет доступа" });
            }

            const { data: timerData, error: timerError } = await supabase
                .from("habit_timers")
                .select("*")
                .eq("id", timerId)
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
                .eq("id", timerId);

            if (updateError) {
                throw updateError;
            }

            const { data: updatedTimer, error: fetchError } = await supabase
                .from("habit_timers")
                .select("id, started_at, end_at, status, pauses, circles")
                .eq("id", timerId)
                .single();

            if (!fetchError && updatedTimer) {
                broadcastTimerUpdate(userId, habitId, updatedTimer);
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