import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
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
            // Получаем привычку
            const { data: habit, error: habitError } = await supabase
                .from("habits")
                .select("*")
                .eq("id", id)
                .single();

            if (habitError || !habit) {
                console.log(habitError);
                return res.status(404).json({ success: false, error: "Привычка не найдена" });
            }

            const today = new Date().toLocaleDateString("en-CA", {
                timeZone: "Europe/Moscow",
            });

            // Получаем выполнение для today
            const { data: completion, error: completionError } = await supabase
                .from("habit_completions")
                .select("id")
                .eq("habit_id", id)
                .eq("user_id", currentUserId)
                .eq("completed_at", today)
                .maybeSingle();

            if (completionError) {
                console.error(completionError);
                return res.status(500).json({ success: false, error: "Ошибка проверки выполнения" });
            }

            const isDone = !!completion;
            const isRead = habit.user_id !== currentUserId;

            // Получаем комментарий для today
            const { data: commentData, error: commentError } = await supabase
                .from("completions_comments")
                .select("comment")
                .eq("habit_id", id)
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
            });
        } catch (err) {
            console.error("Ошибка запроса к Supabase:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
        });
}
