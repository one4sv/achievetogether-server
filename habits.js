import { authenticateUser } from "./middleware/token.js";
import { withRetry } from "./funcs/withRetry.js";

export default function (app, supabase) {
    app.get("/habits", authenticateUser(supabase), async (req, res) => {
        const userId = req.user?.id;
        const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" });

        if (!userId) {
            return res.json({ success: true, habitsArr: [] });
        }

        try {
            const { data: habitsArr, error: habitsError } = await withRetry(() =>
                supabase
                    .from("habits")
                    .select(`
                        *,
                        habits_settings (
                            metric_type,
                            schedule,
                            auto_schedule_completion
                        )
                    `)
                    .eq("user_id", userId)
            );

            if (habitsError) {
                console.error(habitsError);
                return res.status(500).json({ success: false, error: "Ошибка получения привычек" });
            }

            if (!habitsArr || habitsArr.length === 0) {
                return res.json({ success: true, habitsArr: [] });
            }

            const { data: completionsArr, error: completionsError } = await withRetry(() =>
                supabase
                    .from("habit_completions")
                    .select("habit_id")
                    .eq("user_id", userId)
                    .eq("completed_at", today)
            );

            if (completionsError) {
                console.error(completionsError);
                return res.status(500).json({ success: false, error: "Ошибка получения выполнений" });
            }

            const doneSet = new Set(completionsArr?.map(c => c.habit_id) || []);

            const habitsWithDone = habitsArr.map(habit => {
                const settings = habit.habits_settings?.[0] || null;

                return {
                    ...habit,
                    settings,
                    done: doneSet.has(habit.id),
                };
            });

            res.json({
                success: true,
                habitsArr: habitsWithDone,
            });

        } catch (err) {
            console.error("Ошибка запроса к Supabase (/habits):", err);
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: "Ошибка сервера" });
            }
        }
    });

    app.get("/habits/:id", authenticateUser(supabase), async (req, res) => {
        const currentUserId = req.user?.id || null;
        const { id: habitId } = req.params;

        try {
            const { data: habit, error: habitError } = await withRetry(() =>
                supabase
                    .from("habits")
                    .select("*")
                    .eq("id", habitId)
                    .single()
            );

            if (habitError || !habit) {
                console.error(habitError);
                return res.status(404).json({ success: false, error: "Активность не найдена" });
            }

            const { data: settings, error: settingsError } = await withRetry(() =>
                supabase
                    .from("habits_settings")
                    .select("*")
                    .eq("habit_id", habitId)
                    .single()
            );

            if (settingsError) {
                console.error(settingsError);
                return res.status(500).json({ success: false, error: "Ошибка получения настроек привычки" });
            }

            const { data: counterSetRaw, error: counterSetError } = await withRetry(() =>
                supabase
                    .from("counter_settings")
                    .select(`id, min_counter, "red_counter_right", "red_counter_left"`)
                    .eq("habit_id", habitId)
                    .maybeSingle()
            );

            if (counterSetError) {
                console.error(counterSetError);
                return res.status(500).json({ success: false, error: "Ошибка получения настроек счётчика" });
            }

            const counterSettings = counterSetRaw ? {
                id: counterSetRaw.id,
                min_count: Number(counterSetRaw.min_counter),
                red_counter_right: counterSetRaw.red_counter_right !== null ? Number(counterSetRaw.red_counter_right) : null,
                red_counter_left: counterSetRaw.red_counter_left !== null ? Number(counterSetRaw.red_counter_left) : null,
            } : null;

            const { data: privacy, error: privacyError } = await withRetry(() =>
                supabase
                    .from("settings")
                    .select("show_archived_in_acc")
                    .eq("user_id", habit.user_id)
                    .maybeSingle()
            );

            if (privacyError) {
                console.error(privacyError);
                return res.status(500).json({ success: false, error: "Ошибка получения настройки приватности" });
            }

            const showArchived = privacy?.show_archived_in_acc ?? false;

            if (!showArchived && !habit.ongoing && habit.user_id !== currentUserId) {
                return res.status(403).json({ success: false, error: "Пользователь скрыл активность" });
            }

            const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" });
            const startOfDay = new Date(`${today}T00:00:00+03:00`).toISOString();
            const endOfDay = new Date(new Date(startOfDay).getTime() + 24 * 60 * 60 * 1000).toISOString();

            let isDone = false;
            let comment = "";

            if (currentUserId) {
                const { data: completion, error: completionError } = await withRetry(() =>
                    supabase
                        .from("habit_completions")
                        .select("id")
                        .eq("habit_id", habitId)
                        .eq("user_id", currentUserId)
                        .eq("completed_at", today)
                        .maybeSingle()
                );

                if (completionError) {
                    console.error(completionError);
                    return res.status(500).json({ success: false, error: "Ошибка проверки выполнения" });
                }

                isDone = !!completion;

                const { data: commentData, error: commentError } = await withRetry(() =>
                    supabase
                        .from("completions_comments")
                        .select("comment")
                        .eq("habit_id", habitId)
                        .eq("user_id", currentUserId)
                        .eq("date", today)
                        .maybeSingle()
                );

                if (commentError) {
                    console.error(commentError);
                    return res.status(500).json({ success: false, error: "Ошибка получения комментария" });
                }

                comment = commentData?.comment || "";
            }

            const isRead = habit.user_id !== currentUserId;

            let timer = null;
            // if (!isRead) {
                const { data: timerData, error: timerError } = await withRetry(() =>
                    supabase
                        .from("habit_timers")
                        .select("id, started_at, end_at, status, pauses, circles")
                        .eq("habit_id", habitId)
                        .gte("started_at", startOfDay)
                        .lt("started_at", endOfDay)
                        .order("started_at", { ascending: false })
                        .limit(1)
                        .maybeSingle()
                );

                if (timerError) {
                    console.error(timerError);
                    return res.status(500).json({ success: false, error: "Ошибка получения таймера" });
                }

                if (timerData) {
                    timer = {
                        id: Number(timerData.id),
                        started_at: timerData.started_at,
                        end_at: timerData.end_at,
                        status: timerData.status,
                        pauses: timerData.pauses || [],
                        circles: timerData.circles || []
                    };
                }
            // }

            let counter = null;
            // if (!isRead) {
                const { data: counterData, error: counterError } = await withRetry(() =>
                    supabase
                        .from("habit_counters")
                        .select("id, created_at, count, progression, min_count")
                        .eq("habit_id", habitId)
                        .gte("created_at", startOfDay)
                        .lt("created_at", endOfDay)
                        .order("created_at", { ascending: false })
                        .limit(1)
                        .maybeSingle()
                );

                if (counterError) {
                    console.error(counterError);
                    return res.status(500).json({ success: false, error: "Ошибка получения счётчика" });
                }

                if (counterData) {
                    const progressionArray = counterData.progression || [];
                    counter = {
                        id: counterData.id,
                        started_at: new Date(counterData.created_at),
                        count: Number(counterData.count),
                        progression: progressionArray.map(p => ({
                            count: Number(p.count || 0),
                            time: new Date(p.time),
                            text: p.text || ""
                        })),
                        min_count: Number(counterData.min_count)
                    };
                }
            // }
            let checklist = [];

            // if (currentUserId) {
                const { data: completions, error: complError } = await withRetry(() =>
                    supabase
                        .from("checklist_completions")
                        .select("id, name, start_time, end_time, date, habit_id")
                        .eq("habit_id", habitId)
                        .order("start_time", { ascending: true })
                );

                if (complError) {
                    console.error("Ошибка загрузки checklist:", complError);
                } else {
                    checklist = completions || [];
                }
            // }

            res.json({
                success: true,
                habit,
                isDone,
                isRead,
                comment,
                settings,
                timer,
                counter,
                counterSettings,
                checklist
            });

        } catch (err) {
            console.error("Ошибка запроса к Supabase (/habits/:id):", err);
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: "Ошибка сервера" });
            }
        }
    });
}