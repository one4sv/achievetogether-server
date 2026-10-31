import { authenticateUser } from "../../middleware/token.js";
import { withRetry } from "../../utils/withRetry.js";
import { checklistInput, isPositiveId } from "../../utils/validation.js";

export default function (app, supabase) {
    const canUseHabit = async (habitId, userId) => {
        const { data: habit, error } = await supabase.from("habits")
            .select("user_id").eq("id", habitId).maybeSingle();
        if (error || !habit) return false;
        if (habit.user_id === userId) return true;
        const { data: member, error: memberError } = await supabase.from("habit_members")
            .select("status").eq("habit_id", habitId).eq("user_id", userId)
            .eq("status", "accepted").maybeSingle();
        return !memberError && !!member;
    };

    app.post("/checklist/save", authenticateUser(supabase), async (req, res) => {
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

            if (!habit || !(await canUseHabit(habit_id, userId))) {
                return res.status(403).json({ success: false, error: "Привычка не найдена или нет доступа" });
            }

            const { data, error } = await
                supabase
                    .from("checklist_completions")
                    .insert({
                        ...input,
                        habit_id,
                        user_id: userId
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

    app.post("/checklist/delete", authenticateUser(supabase), async (req, res) => {
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
                .eq("user_id", userId)
                .single();

            if (fetchError || !block) {
                return res.status(404).json({ success: false, error: "Блок не найден" });
            }

            const { data: habit } = await supabase
                .from("habits")
                .select("id")
                .eq("id", block.habit_id)
                .single();

            if (!habit || !(await canUseHabit(block.habit_id, userId))) {
                return res.status(403).json({ success: false, error: "Нет доступа" });
            }

            const { error } = await withRetry(() =>
                supabase
                    .from("checklist_completions")
                    .delete()
                    .eq("id", id)
                    .eq("user_id", userId)
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
                .eq("user_id", userId)
                .single();

            if (fetchError || !block) {
                return res.status(404).json({ success: false, error: "Блок не найден" });
            }

            const { data: habit } = await supabase
                .from("habits")
                .select("id")
                .eq("id", block.habit_id)
                .single();

            if (!habit || !(await canUseHabit(block.habit_id, userId))) {
                return res.status(403).json({ success: false, error: "Нет доступа" });
            }

            const { data, error } = await withRetry(() =>
                supabase
                    .from("checklist_completions")
                    .update(input)
                    .eq("id", id)
                    .eq("user_id", userId)
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
