import { authenticateUser } from "./middleware/token.js";
import { withRetry } from "./funcs/withRetry.js";

export default function (app, supabase) {
    app.post("/checklist/save", authenticateUser(supabase), async (req, res) => {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, error: "Не авторизован" });

        const { name, start_time, end_time, date, habit_id } = req.body;

        if (!habit_id || !date || !name?.trim()) {
            return res.status(400).json({ success: false, error: "Недостаточно данных" });
        }

        try {
            const { data: habit } = await supabase
                .from("habits")
                .select("id")
                .eq("id", habit_id)
                .eq("user_id", userId)
                .single();

            if (!habit) {
                return res.status(403).json({ success: false, error: "Привычка не найдена или нет доступа" });
            }

            const { data, error } = await withRetry(() =>
                supabase
                    .from("checklist_completions")
                    .insert({
                        name,
                        start_time: start_time || null,
                        end_time: end_time || null,
                        date,
                        habit_id
                    })
                    .select()
                    .single()
            );

            if (error) throw error;

            res.json({
                success: true,
            });

        } catch (err) {
            console.error("Ошибка сохранения checklist:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера при сохранении" });
        }
    });

    app.post("/checklist/delete", authenticateUser(supabase), async (req, res) => {
        const userId = req.user?.id;
        const { id } = req.body;

        if (!userId) {
            return res.status(401).json({ success: false, error: "Не авторизован" });
        }

        try {
            const { data: block, error: fetchError } = await supabase
                .from("checklist_completions")
                .select("id, habit_id")
                .eq("id", id)
                .single();

            if (fetchError || !block) {
                return res.status(404).json({ success: false, error: "Блок не найден" });
            }

            const { data: habit } = await supabase
                .from("habits")
                .select("id")
                .eq("id", block.habit_id)
                .eq("user_id", userId)
                .single();

            if (!habit) {
                return res.status(403).json({ success: false, error: "Нет доступа" });
            }

            const { error } = await withRetry(() =>
                supabase
                    .from("checklist_completions")
                    .delete()
                    .eq("id", id)
            );

            if (error) throw error;

            res.json({ success: true });

        } catch (err) {
            console.error("Ошибка удаления:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера при удалении" });
        }
    });
    
    app.post("/checklist/update", authenticateUser(supabase), async (req, res) => {
        const userId = req.user?.id;

        const { id, name, start_time, end_time, date } = req.body;

        if (!userId) {
            return res.status(401).json({ success: false, error: "Не авторизован" });
        }

        if (!id || !name?.trim() || !date) {
            return res.status(400).json({ success: false, error: "Недостаточно данных" });
        }

        try {
            const { data: block, error: fetchError } = await supabase
                .from("checklist_completions")
                .select("id, habit_id")
                .eq("id", id)
                .single();

            if (fetchError || !block) {
                return res.status(404).json({ success: false, error: "Блок не найден" });
            }

            const { data: habit } = await supabase
                .from("habits")
                .select("id")
                .eq("id", block.habit_id)
                .eq("user_id", userId)
                .single();

            if (!habit) {
                return res.status(403).json({ success: false, error: "Нет доступа" });
            }

            const { data, error } = await withRetry(() =>
                supabase
                    .from("checklist_completions")
                    .update({
                        name,
                        start_time: start_time || null,
                        end_time: end_time || null,
                        date
                    })
                    .eq("id", id)
                    .select()
                    .single()
            );

            if (error) throw error;

            res.json({
                success: true,
                block: data
            });

        } catch (err) {
            console.error("Ошибка обновления:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера при обновлении" });
        }
    });

}