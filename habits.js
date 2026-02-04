import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
    app.get("/habits", authenticateUser(supabase), async (req, res) => {
        const { id: userId } = req.user;
        const today = new Date().toLocaleDateString("en-CA", {
            timeZone: "Europe/Moscow",
        });

        try {
            const { data: habitsArr, error: habitsError } = await supabase
                .from("habits")
                .select("*")
                .eq("user_id", userId);

            if (habitsError) {
                console.error(habitsError);
                return res.status(500).json({ success: false, error: "Ошибка получения активносетй" });
            }

            if (!habitsArr) {
                return res.json({ success: true, habitsArr: [] });
            }

            // Выполнения за сегодня
            const { data: completionsArr, error: completionsError } = await supabase
                .from("habit_completions")
                .select("habit_id")
                .eq("user_id", userId)
                .eq("completed_at", today);

            if (completionsError) {
                console.error(completionsError);
                return res.status(500).json({ success: false, error: "Ошибка получения выполнений" });
            }

            const doneSet = new Set(completionsArr?.map(c => c.habit_id) || []);

            const habitsWithDone = habitsArr.map(habit => ({
                ...habit,
                done: doneSet.has(habit.id),
            }));

            res.json({
                success: true,
                habitsArr: habitsWithDone,
            });
        } catch (err) {
            console.error("Ошибка запроса к Supabase:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });

    app.get("/habits/:id", authenticateUser(supabase), async (req, res) => {
        const { id: currentUserId } = req.user;
        const { id: habitId } = req.params;
        try {
            // Получаем привычку
            const { data: habit, error: habitError } = await supabase
                .from("habits")
                .select("*")
                .eq("id", habitId)
                .single();

            if (habitError || !habit) {
                console.error(habitError);
                return res.status(404).json({ success: false, error: "Активность не найдена" });
            }

            const { data: settings, error: settingsError } = await supabase
                .from("habits_settings")
                .select("*")
                .eq("habit_id", habitId)
                .single()

            if (settingsError) {
                console.error(settingsError);
                return res.status(500).json({ success: false, error: "Ошибка получения настройек привычки" });
            }

            // Настройки счётчика (всегда, даже для read-only)
            const { data: counterSetRaw, error: counterSetError } = await supabase
                .from("counter_settings")
                .select(`id, min_counter, "red_counter_right", "red_counter_left"`)
                .eq("habit_id", habitId)
                .maybeSingle();

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

            const { data: privacy, error: privacyError } = await supabase
                .from("settings")
                .select("show_archived_in_acc")
                .eq("user_id", habit.user_id)
                .maybeSingle();

            if (privacyError) {
                console.error(privacyError);
                return res.status(500).json({ success: false, error: "Ошибка получения настройки" });
            }

            const showArchived = privacy?.show_archived_in_acc ?? false;

            if (!showArchived && habit.is_archived && habit.user_id !== currentUserId) {
                return res.status(403).json({ success: false, error: "Пользователь скрыл активность" });
            }

            const today = new Date().toLocaleDateString("en-CA", {
                timeZone: "Europe/Moscow",
            });
            const startOfDay = new Date(`${today}T00:00:00+03:00`).toISOString();
            const endOfDay = new Date(new Date(startOfDay).getTime() + 24 * 60 * 60 * 1000).toISOString();

            // Выполнение за сегодня (для текущего пользователя)
            const { data: completion, error: completionError } = await supabase
                .from("habit_completions")
                .select("id")
                .eq("habit_id", habitId)
                .eq("user_id", currentUserId)
                .eq("completed_at", today)
                .maybeSingle();

            if (completionError) {
                console.error(completionError);
                return res.status(500).json({ success: false, error: "Ошибка проверки выполнения" });
            }

            const isDone = !!completion;
            const isRead = habit.user_id !== currentUserId;

            // Комментарий за сегодня
            const { data: commentData, error: commentError } = await supabase
                .from("completions_comments")
                .select("comment")
                .eq("habit_id", habitId)
                .eq("user_id", currentUserId)
                .eq("date", today)
                .maybeSingle();

            if (commentError) {
                console.error(commentError);
                return res.status(500).json({ success: false, error: "Ошибка получения комментария" });
            }

            const comment = commentData?.comment || "";

            let timer = null;
            if (!isRead) {
                const { data: timerData, error: timerError } = await supabase
                    .from("habit_timers")
                    .select("id, started_at, end_at, status, pauses, circles")
                    .eq("habit_id", habitId)
                    .gte("end_at", startOfDay)
                    .lt("end_at", endOfDay)
                    .order("started_at", { ascending: false })
                    .limit(1)
                    .maybeSingle();

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
            }

            let counter = null;
            if (!isRead) {
                const { data: counterData, error: counterError } = await supabase
                    .from("habit_counters")
                    .select("id, created_at, count, progression, min_count")
                    .eq("habit_id", habitId)
                    .gte("created_at", startOfDay)
                    .lt("created_at", endOfDay)
                    .order("created_at", { ascending: false })
                    .limit(1)
                    .maybeSingle();

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
            }

            res.json({
                success: true,
                habit,
                isDone,
                isRead,
                comment,
                settings,
                timer,
                counter,
                counterSettings
            });
        } catch (err) {
            console.error("Ошибка запроса к Supabase:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });
}