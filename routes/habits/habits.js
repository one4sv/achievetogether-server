import { filterBlockedHabitMemberships, getHabitAccess, requireHabitPermission } from "../../utils/habitAccess.js";
import { authenticateUser } from "../../middleware/token.js";
import { withRetry } from "../../utils/withRetry.js";

export default function (app, supabase) {
    app.get("/habits", authenticateUser(supabase), async (req, res) => {
        const userId = req.user?.id;
        const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" });

        if (!userId) {
            return res.json({ success: true, habitsArr: [] });
        }

        try {
            const { data: memberships, error: membersError } = await supabase
                .from("habit_members").select("habit_id")
                .eq("user_id", userId).eq("status", "accepted");
            if (membersError) throw membersError;
            const acceptedIds = (memberships || []).map(member => member.habit_id);
            const { data: habitsRaw, error: habitsError } = await withRetry(() =>
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
                    .or(`user_id.eq.${userId}${acceptedIds.length ? `,id.in.(${acceptedIds.join(",")})` : ""}`)
            );

            if (habitsError) {
                console.error(habitsError);
                console.error("cause:", habitsError.cause);
                return res.status(500).json({ success: false, error: "Ошибка получения привычек" });
            }

            const habitsArr = await filterBlockedHabitMemberships(supabase, habitsRaw, userId);

            if (!habitsArr || habitsArr.length === 0) {
                return res.json({ success: true, habitsArr: [] });
            }

            const { data: completionsArr, error: completionsError } = await withRetry(() =>
                supabase
                    .from("habit_completions")
                    .select("habit_id, user_id")
                    .eq("user_id", userId)
                    .eq("completed_at", today)
            );

            if (completionsError) {
                console.error(completionsError);
                return res.status(500).json({ success: false, error: "Ошибка получения выполнений" });
            }

            const sharedHabits = habitsArr.filter(h => h.metric_progress_mode === "shared" && h.user_id !== userId);
            let sharedCompletions = [];
            if (sharedHabits.length) {
                const { data, error } = await supabase.from("habit_completions")
                    .select("habit_id, user_id")
                    .in("habit_id", sharedHabits.map(h => h.id))
                    .in("user_id", [...new Set(sharedHabits.map(h => h.user_id))])
                    .eq("completed_at", today);
                if (error) throw error;
                sharedCompletions = data || [];
            }
            const doneSet = new Set([...(completionsArr || []), ...sharedCompletions]
                .map(c => `${c.habit_id}:${c.user_id}`));

            const habitsWithDone = habitsArr.map(habit => {
                const settings = habit.habits_settings?.[0] || null;

                return {
                    ...habit,
                    settings,
                    done: doneSet.has(`${habit.id}:${habit.metric_progress_mode === "shared" ? habit.user_id : userId}`),
                    isOwner: habit.user_id === userId,
                };
            });

            res.json({
                success: true,
                habitsArr: habitsWithDone,
            });

        } catch (err) {
            console.error("Ошибка запроса к Supabase (/habits):", err);
            console.error("cause:", err.cause);
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

            const access = await getHabitAccess(supabase, habit.id, currentUserId);
            if (!access?.can_view) return res.status(403).json({ success: false, error: "Нет доступа к активности" });
            const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" });
            const startOfDay = new Date(`${today}T00:00:00+03:00`).toISOString();
            const endOfDay = new Date(new Date(startOfDay).getTime() + 24 * 60 * 60 * 1000).toISOString();

            const progressUserId = access.progress_user_id;
            let isDone = false;
            let comment = "";

            if (currentUserId) {
                const { data: completion, error: completionError } = await withRetry(() =>
                    supabase
                        .from("habit_completions")
                        .select("id")
                        .eq("habit_id", habitId)
                        .eq("user_id", progressUserId)
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

            const isRead = !access.can_edit_info;

            let timer = null;
            // if (!isRead) {
                const { data: timerData, error: timerError } = await withRetry(() =>
                    supabase
                        .from("habit_timers")
                        .select("id, started_at, end_at, status, pauses, circles")
                        .eq("habit_id", habitId)
                        .eq("user_id", progressUserId || habit.user_id)
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
                        .eq("user_id", progressUserId || habit.user_id)
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
                        .eq("user_id", progressUserId || habit.user_id)
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
                habit: { ...habit, access },
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