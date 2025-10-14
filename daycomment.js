import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
    app.post("/daycomment", authenticateUser(supabase), async (req, res) => {
        const { id: user_id } = req.user;
        const { habit_id, text } = req.body;

        try {
            const today = new Date().toLocaleDateString("en-CA", {
                timeZone: "Europe/Moscow"
            });

            const { data: existing, error: selectError } = await supabase
                .from("habit_completions")
                .select("id")
                .eq("habit_id", habit_id)
                .eq("user_id", user_id)
                .eq("completed_at", today);

            if (selectError) {
                console.error("Ошибка проверки комментария:", selectError);
                return res.status(500).json({ success: false, error: selectError.message });
            }

            if (existing.length > 0) {
                const { error: updateError } = await supabase
                    .from("habit_completions")
                    .update({ comment: text })
                    .eq("id", existing[0].id);

                if (updateError) {
                    console.error("Ошибка обновления комментария:", updateError);
                    return res.status(500).json({ success: false, error: updateError.message });
                }

                return res.status(200).json({ success: true, action: "updated" });
            } else {
                const { data, error: insertError } = await supabase
                    .from("habit_completions")
                    .insert([
                        {
                            habit_id,
                            user_id,
                            completed_at: today,
                            comment: text,
                        },
                    ]);

                if (insertError) {
                    console.error("Ошибка вставки комментария:", insertError);
                    return res.status(500).json({ success: false, error: insertError.message });
                }

                return res.status(200).json({ success: true });
            }
        } catch (err) {
        console.error("Ошибка сервера:", err);
        return res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });
}