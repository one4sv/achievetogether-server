import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
    app.post("/markplan", authenticateUser(supabase), async (req, res) => {
        const { habit_id, date } = req.body;
        const { id: user_id } = req.user;

        if (!habit_id || !date) {
            return res.status(400).json({
                success: false,
                error: "habit_id и date обязательны"
            });
        }

        try {
            // Проверяем, что привычка принадлежит пользователю
            const { data: habit, error: habitError } = await supabase
                .from("habits")
                .select("id")
                .eq("id", habit_id)
                .eq("user_id", user_id)
                .single();

            if (habitError || !habit) {
                return res.status(404).json({
                    success: false,
                    error: "Привычка не найдена"
                });
            }

            // Проверяем, существует ли уже план
            const { data: existing, error: existingError } = await supabase
                .from("habit_planned")
                .select("id")
                .eq("habit_id", habit_id)
                .eq("planned_at", date)
                .maybeSingle();

            if (existingError) {
                console.log(existingError);
                return res.status(500).json({
                    success: false,
                    error: "Ошибка проверки плана"
                });
            }

            if (existing) {
                // Удаляем план
                const { error } = await supabase
                    .from("habit_planned")
                    .delete()
                    .eq("id", existing.id);

                if (error) {
                    console.log(error);
                    return res.status(500).json({
                        success: false,
                        error: "Ошибка удаления плана"
                    });
                }

                return res.json({
                    success: true,
                    planned: false
                });
            }

            // Создаём план
            const { error } = await supabase
                .from("habit_planned")
                .insert({
                    habit_id,
                    planned_at: date
                });

            if (error) {
                console.log(error);
                return res.status(500).json({
                    success: false,
                    error: "Ошибка создания плана"
                });
            }

            return res.json({
                success: true,
                planned: true
            });

        } catch (err) {
            console.error(err);
            return res.status(500).json({
                success: false,
                error: "Ошибка сервера"
                });
        }
    });
}