import { authenticateUser } from "./middleware/token.js"

export default function(app, supabase) {
    app.post("/toggleblocked", authenticateUser(supabase), async (req, res) => {
        const { id:id1 } = req.user;
        const { id:id2 } = req.body;

        try {
            const { data:chat, error:chat_error } = await supabase
                .from("chat_members")
                .select("chat_id")
                .in("user_id", [id1, id2])

            if (chat_error || !chat || chat.length === 0) {
                return res.status(404).json({ success: false, error: "Чат не найден" });
            }

            const chatId = chat[0].chat_id;

            const { data: oldBlocked, error: blocked_error } = await supabase
                .from("chat_members")
                .select("is_blocked")
                .eq("user_id", id1)
                .eq("chat_id", chatId)
                .single()

            if (blocked_error || !oldBlocked) {
                return res.status(404).json({ success: false, error: "Ошибка получения is_blocked" });
            }

            const newBlockedValue = !oldBlocked.is_blocked;

            const { error:update_error } = await supabase
                .from("chat_members")
                .update({ is_blocked: newBlockedValue })
                .eq("user_id", id1)
                .eq("chat_id", chatId)

            if (update_error) {
                return res.status(500).json({ success: false, error: "Ошибка обновления" });
            }

            res.json({
                success: true,
                is_blocked: newBlockedValue
            });
        } catch (err) {
            console.error("Ошибка запроса к Supabase:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });
}