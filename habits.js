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
            // Получаем настройку show_archieved владельца привычки
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

            // Если архивирована и не разрешено показывать — скрываем
            if (!showArchived && habit.is_archived && habit.user_id !== currentUserId) {
                return res.status(403).json({ success: false, error: "Пользователь скрыл активность" });
            }

            const today = new Date().toLocaleDateString("en-CA", {
                timeZone: "Europe/Moscow",
            });

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

            res.json({
                success: true,
                habit,
                isDone,
                isRead,
                comment,
                settings
            });
        } catch (err) {
            console.error("Ошибка запроса к Supabase:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });
}