import { getHabitAccess, requireHabitPermission } from "../../utils/habitAccess.js";
import { authenticateUser } from "../../middleware/token.js";
import { withRetry } from "../../utils/withRetry.js";
import { checklistInput, isPositiveId } from "../../utils/validation.js";

export default function (app, supabase) {
    app.post("/checklist/save", authenticateUser(supabase), requireHabitPermission(supabase, "complete"), async (req, res) => {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, error: "Не авторизован" });

        const { name, start_time, end_time, date, habit_id } = req.body;
        const input = checklistInput({ name, start_time, end_time, date });

        if (!isPositiveId(habit_id) || !input) {
            return res.status(400).json({ success: false, error: "Недостаточно данных" });
        }

        try {
            const { data: habit } = await supabase
                .from("habits")
                .select("id")
                .eq("id", habit_id)
                .single();

            if (!habit) {
                return res.status(403).json({ success: false, error: "Привычка не найдена или нет доступа" });
            }

            const { data, error } = await
                supabase
                    .from("checklist_completions")
                    .insert({
                        ...input,
                        habit_id,
                        user_id: req.habitAccess.progress_user_id
                    })
                    .select()
                    .single();

            if (error) throw error;

            res.json({
                success: true,
                block: data,
            });

        } catch (err) {
            console.error("Ошибка сохранения checklist:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера при сохранении" });
        }
    });

    const checklistHabitId = async req => {
        const { data, error } = await supabase.from("checklist_completions").select("habit_id").eq("id", req.body?.id).maybeSingle();
        if (error) throw error;
        return data?.habit_id;
    };

    app.post("/checklist/delete", authenticateUser(supabase), requireHabitPermission(supabase, "complete", checklistHabitId), async (req, res) => {
        const userId = req.user?.id;
        const { id } = req.body;
        if (!isPositiveId(id)) return res.status(400).json({ success: false, error: "Некорректный ID блока" });

        if (!userId) {
            return res.status(401).json({ success: false, error: "Не авторизован" });
        }

        try {
            const { data: block, error: fetchError } = await supabase
                .from("checklist_completions")
                .select("id, habit_id")
                .eq("id", id)
                .eq("user_id", req.habitAccess.progress_user_id)
                .single();

            if (fetchError || !block) {
                return res.status(404).json({ success: false, error: "Блок не найден" });
            }

            const { data: habit } = await supabase
                .from("habits")
                .select("id")
                .eq("id", block.habit_id)
                .single();

            if (!habit) {
                return res.status(403).json({ success: false, error: "Нет доступа" });
            }

            const { error } = await withRetry(() =>
                supabase
                    .from("checklist_completions")
                    .delete()
                    .eq("id", id)
                    .eq("user_id", req.habitAccess.progress_user_id)
            );

            if (error) throw error;

            res.json({ success: true });

        } catch (err) {
            console.error("Ошибка удаления:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера при удалении" });
        }
    });
    
    app.post("/checklist/update", authenticateUser(supabase), requireHabitPermission(supabase, "complete", checklistHabitId), async (req, res) => {
        const userId = req.user?.id;

        const { id, name, start_time, end_time, date } = req.body;
        const input = checklistInput({ name, start_time, end_time, date });

        if (!userId) {
            return res.status(401).json({ success: false, error: "Не авторизован" });
        }

        if (!isPositiveId(id) || !input) {
            return res.status(400).json({ success: false, error: "Недостаточно данных" });
        }

        try {
            const { data: block, error: fetchError } = await supabase
                .from("checklist_completions")
                .select("id, habit_id")
                .eq("id", id)
                .eq("user_id", req.habitAccess.progress_user_id)
                .single();

            if (fetchError || !block) {
                return res.status(404).json({ success: false, error: "Блок не найден" });
            }

            const { data: habit } = await supabase
                .from("habits")
                .select("id")
                .eq("id", block.habit_id)
                .single();

            if (!habit) {
                return res.status(403).json({ success: false, error: "Нет доступа" });
            }

            const { data, error } = await withRetry(() =>
                supabase
                    .from("checklist_completions")
                    .update(input)
                    .eq("id", id)
                    .eq("user_id", req.habitAccess.progress_user_id)
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
