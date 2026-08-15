import { authenticateUser } from "./middleware/token.js";
import { withRetry } from "./funcs/withRetry.js";

export default function (app, supabase) {
    app.get(
        "/habits/:id/stats",
        authenticateUser(supabase),
        async (req, res) => {
            const currentUserId = req.user?.id;
            const { id: habitId } = req.params;

            if (!currentUserId) {
                return res.status(401).json({
                    success: false,
                    error: "Не авторизован"
                });
            }

            try {
                // =========================
                // HABIT
                // =========================

                const { data: habit, error: habitError } = await withRetry(() =>
                    supabase
                        .from("habits")
                        .select("id, user_id, start_date, end_date")
                        .eq("id", habitId)
                        .single()
                );

                if (habitError || !habit) {
                    return res.status(404).json({
                        success: false,
                        error: "Привычка не найдена"
                    });
                }

                if (habit.user_id !== currentUserId) {
                    return res.status(403).json({
                        success: false,
                        error: "Нет доступа"
                    });
                }

                // =========================
                // SETTINGS
                // =========================

                const { data: settings, error: settingsError } =
                    await withRetry(() =>
                        supabase
                            .from("habits_settings")
                            .select("metric_type")
                            .eq("habit_id", habitId)
                            .single()
                    );

                if (settingsError) {
                    return res.status(500).json({
                        success: false,
                        error: "Ошибка получения настроек"
                    });
                }

                const metricType = settings.metric_type;

                // =========================
                // COMPLETIONS
                // =========================

                const { data: completions, error: completionsError } =
                    await withRetry(() =>
                        supabase
                            .from("habit_completions")
                            .select("completed_at")
                            .eq("habit_id", habitId)
                            .order("completed_at", {
                                ascending: true
                            })
                    );

                if (completionsError) {
                    console.error(completionsError);

                    return res.status(500).json({
                        success: false,
                        error: "Ошибка получения выполнений"
                    });
                }

                const completedDates = [
                    ...new Set(
                        (completions || []).map(c => c.completed_at)
                    )
                ];

                // =========================
                // DATE RANGE
                // =========================

                const startDate = new Date(habit.start_date);

                const endDate = habit.end_date
                    ? new Date(habit.end_date)
                    : new Date();

                const days = [];

                const current = new Date(startDate);
                current.setHours(0, 0, 0, 0);

                const end = new Date(endDate);
                end.setHours(0, 0, 0, 0);

                while (current <= end) {
                    const year = current.getFullYear();
                    const month = String(
                        current.getMonth() + 1
                    ).padStart(2, "0");
                    const day = String(
                        current.getDate()
                    ).padStart(2, "0");

                    days.push(`${year}-${month}-${day}`);

                    current.setDate(current.getDate() + 1);
                }

                // =========================
                // BASIC STATS
                // =========================

                let done = 0;
                let skip = 0;

                let bestStreak = 0;
                let tempStreak = 0;

                let maxBreak = 0;
                let tempBreak = 0;

                let bestStart = "";
                let bestEnd = "";

                let breakStart = "";
                let breakEnd = "";

                let tempBreakStart = "";
                let tempStreakStart = "";

                const streaks = [];
                const breaks = [];

                const completedSet = new Set(completedDates);

                for (const day of days) {
                    const isDone = completedSet.has(day);

                    if (isDone) {
                        done++;

                        if (tempStreak === 0) {
                            tempStreakStart = day;
                        }

                        tempStreak++;

                        if (tempBreak > 0) {
                            breaks.push(tempBreak);

                            if (tempBreak > maxBreak) {
                                maxBreak = tempBreak;
                                breakStart = tempBreakStart;
                                breakEnd = day;
                            }
                        }

                        tempBreak = 0;
                    } else {
                        skip++;

                        if (tempStreak > 0) {
                            streaks.push(tempStreak);

                            if (tempStreak > bestStreak) {
                                bestStreak = tempStreak;
                                bestStart = tempStreakStart;

                                const previousIndex =
                                    days.indexOf(day) - 1;

                                bestEnd = days[previousIndex];
                            }
                        }

                        tempStreak = 0;

                        if (tempBreak === 0) {
                            tempBreakStart = day;
                        }

                        tempBreak++;
                    }
                }

                if (tempStreak > 0) {
                    streaks.push(tempStreak);

                    if (tempStreak > bestStreak) {
                        bestStreak = tempStreak;
                        bestStart = tempStreakStart;
                        bestEnd = days[days.length - 1];
                    }
                }

                if (tempBreak > 0) {
                    breaks.push(tempBreak);

                    if (tempBreak > maxBreak) {
                        maxBreak = tempBreak;
                        breakStart = tempBreakStart;
                        breakEnd = days[days.length - 1];
                    }
                }

                const longStreaks =
                    streaks.filter(streak => streak >= 3);

                const streakCount = longStreaks.length;

                const streakMiddle = longStreaks.length
                    ? Math.round(
                        longStreaks.reduce(
                            (sum, value) => sum + value,
                            0
                        ) / longStreaks.length
                    )
                    : 0;

                const streakMax =
                    bestStreak >= 3
                        ? bestStreak
                        : 0;

                const breakMiddle = breaks.length
                    ? Math.round(
                        breaks.reduce(
                            (sum, value) => sum + value,
                            0
                        ) / breaks.length
                    )
                    : 0;

                const allCount = done + skip;

                const compProcent = allCount
                    ? Math.round((done / allCount) * 100)
                    : 0;

                const skipProcent = allCount
                    ? Math.round((skip / allCount) * 100)
                    : 0;

                const stats = {
                    compCount: done,
                    compProcent: `${compProcent}%`,

                    skipCount: skip,
                    skipProcent: `${skipProcent}%`,

                    streakCount,
                    streakMax,
                    streakMiddle,

                    breakMax: maxBreak,
                    breakMiddle,

                    allCount
                };

                const extras = {
                    streakMax:
                        bestStreak >= 3 &&
                        bestStart &&
                        bestEnd
                            ? `${bestStart} - ${bestEnd}`
                            : "",

                    breakMax:
                        breakStart &&
                        breakEnd
                            ? `${breakStart} - ${breakEnd}`
                            : ""
                };

                // =========================
                // COUNTER
                // =========================

                if (metricType === "counter") {
                    const { data: counters, error } =
                        await withRetry(() =>
                            supabase
                                .from("habit_counters")
                                .select("count, created_at")
                                .eq("habit_id", habitId)
                                .order("created_at", {
                                    ascending: true
                                })
                        );

                    if (error) {
                        return res.status(500).json({
                            success: false,
                            error: "Ошибка получения статистики счётчика"
                        });
                    }

                    const values = (counters || [])
                        .map(c => Number(c.count))
                        .filter(Number.isFinite);

                    if (values.length) {
                        stats.fullCounter =
                            values.reduce(
                                (sum, value) => sum + value,
                                0
                            );

                        stats.maxCounter =
                            Math.max(...values);

                        stats.middleCounter =
                            Math.round(
                                values.reduce(
                                    (sum, value) => sum + value,
                                    0
                                ) / values.length
                            );
                    } else {
                        stats.fullCounter = 0;
                        stats.maxCounter = 0;
                        stats.middleCounter = 0;
                    }
                }

                // =========================
                // TIMER
                // =========================

                if (metricType === "timer") {
                    const { data: timers, error } =
                        await withRetry(() =>
                            supabase
                                .from("habit_timers")
                                .select(
                                    "started_at, end_at, status"
                                )
                                .eq("habit_id", habitId)
                                .order("started_at", {
                                    ascending: true
                                })
                        );

                    if (error) {
                        return res.status(500).json({
                            success: false,
                            error: "Ошибка получения статистики таймера"
                        });
                    }

                    const durations = (timers || [])
                        .filter(
                            timer =>
                                timer.started_at &&
                                timer.end_at
                        )
                        .map(timer => {
                            const start =
                                new Date(timer.started_at)
                                    .getTime();

                            const end =
                                new Date(timer.end_at)
                                    .getTime();

                            return Math.max(
                                0,
                                end - start
                            );
                        });

                    if (durations.length) {
                        const total =
                            durations.reduce(
                                (sum, value) => sum + value,
                                0
                            );

                        stats.fullTimer =
                            Math.round(total / 1000);

                        stats.maxTimer =
                            Math.round(
                                Math.max(...durations) / 1000
                            );

                        stats.middleTimer =
                            Math.round(
                                total /
                                durations.length /
                                1000
                            );
                    } else {
                        stats.fullTimer = 0;
                        stats.maxTimer = 0;
                        stats.middleTimer = 0;
                    }
                }

                // =========================
                // SCHEDULE
                // =========================

                if (metricType === "schedule") {
                    const { data: scheduleCompletions, error } =
                        await withRetry(() =>
                            supabase
                                .from("schedule_completions")
                                .select("date, schedule_id")
                                .eq("habit_id", habitId)
                                .order("date", {
                                    ascending: true
                                })
                        );

                    if (error) {
                        return res.status(500).json({
                            success: false,
                            error: "Ошибка получения статистики расписания"
                        });
                    }

                    const values =
                        scheduleCompletions || [];

                    stats.fullSchedule =
                        values.length;

                    const byDate = new Map();

                    for (const completion of values) {
                        const date =
                            completion.date;

                        byDate.set(
                            date,
                            (byDate.get(date) || 0) + 1
                        );
                    }

                    const dailyValues =
                        [...byDate.values()];

                    stats.maxSchedule =
                        dailyValues.length
                            ? Math.max(...dailyValues)
                            : 0;

                    stats.middleSchedule =
                        dailyValues.length
                            ? Math.round(
                                dailyValues.reduce(
                                    (sum, value) =>
                                        sum + value,
                                    0
                                ) / dailyValues.length
                            )
                            : 0;
                }

                return res.json({
                    success: true,
                    metricType,
                    stats,
                    extras
                });

            } catch (err) {
                console.error(
                    "Ошибка /habits/:id/overall-stats:",
                    err
                );

                return res.status(500).json({
                    success: false,
                    error: "Ошибка сервера"
                });
            }
        }
    );
}