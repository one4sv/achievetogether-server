import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
    // Получить все привычки пользователя
    app.get("/habits", authenticateUser(supabase), async (req, res) => {
        const { id } = req.user;

        try {
            const { data: habitsArr, error } = await supabase
                .from("habits")
                .select("*")
                .eq("user_id", id);

            if (error) {
                console.log(error);
                return res.status(404).json({ success: false, error: "Пользователь не найден" });
            }

            res.json({
                success: true,
                habitsArr,
            });
        } catch (err) {
            console.error("Ошибка запроса к Supabase:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });

    app.get("/habits/:id", authenticateUser(supabase), async (req, res) => {
        const { id: currentUserId } = req.user;
        const { id } = req.params;

        try {
            const { data: habit, error: habitError } = await supabase
                .from("habits")
                .select("*")
                .eq("id", id)
                .single();

            if (habitError || !habit) {
                console.log(habitError);
                return res
                    .status(404)
                    .json({ success: false, error: "Привычка не найдена" });
            }

            // текущая дата
            const today = new Date().toLocaleDateString("en-CA", {
                timeZone: "Europe/Moscow"
            });
            console.log(today); // '2025-10-15'
            const { data: completion, error: completionError } = await supabase
                .from("habit_completions")
                .select("id, comment")
                .eq("habit_id", id)
                .eq("user_id", currentUserId)
                .eq("completed_at", today)
                .maybeSingle();

            if (completionError) {
                console.error(completionError);
                return res.status(500).json({
                    success: false,
                    error: "Ошибка проверки выполнения",
                });
            }

            const isDone = !!completion;
            const isRead = habit.user_id !== currentUserId;
            const comment = completion?.comment || "";

            res.json({
                success: true,
                habit,
                isDone,
                isRead,
                comment,
            });
        } catch (err) {
            console.error("Ошибка запроса к Supabase:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });
}
