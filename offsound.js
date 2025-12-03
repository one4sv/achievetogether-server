import { authenticateUser } from "./middleware/token.js"

export default function(app, supabase) {
    app.post("/offsound", authenticateUser(supabase), async (req, res) => {
        const { id:id1 } = req.user;
        const { id:id2 } = req.body;

        try {
            const { data: chat, error: chat_error } = await supabase
                .rpc("get_shared_chat", { uid1: id1, uid2: id2 });

            if (chat_error || !chat || chat.length === 0) {
                return res.status(404).json({ success: false, error: "Чат не найден" });
            }

            const chatId = chat[0].chat_id;

            const { data: oldNote, error: note_error } = await supabase
                .from("chat_members")
                .select("note")
                .eq("user_id", id1)
                .eq("chat_id", chatId)
                .single()

            if (note_error || !oldNote) {
                return res.status(404).json({ success: false, error: "Ошибка получения note" });
            }

            const { error:update_error } = await supabase
                .from("chat_members")
                .update({ note: !oldNote.note })
                .eq("user_id", id1)
                .eq("chat_id", chatId)

            if (update_error) {
                return res.status(500).json({ success: false, error: "Ошибка обновления" });
            }

            res.json({
                success: true,
            });
        } catch (err) {
            console.error("Ошибка запроса к Supabase:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });
}
