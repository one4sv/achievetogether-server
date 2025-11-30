import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
    app.post("/delete", authenticateUser(supabase), async (req, res) => {
        const { goal, delete_id } = req.body; // delete_id - user_id собеседника (UUID)
        const { id: user_id } = req.user;    // текущий пользователь (UUID)

        try {
            if (goal === "habit") {
                const { error } = await supabase
                    .from("habits")
                    .delete()
                    .eq("id", Number(delete_id))
                    .eq("user_id", user_id);

                if (error) throw error;
            } 
            else if (goal === "chat") {
                // 1. Получаем все chat_id для текущего пользователя
                const { data: chatsUser1, error: err1 } = await supabase
                    .from("chat_members")
                    .select("chat_id")
                    .eq("user_id", user_id);
                if (err1) throw err1;

                // 2. Получаем все chat_id для удаляемого пользователя
                const { data: chatsUser2, error: err2 } = await supabase
                    .from("chat_members")
                    .select("chat_id")
                    .eq("user_id", delete_id);
                if (err2) throw err2;

                // 3. Находим пересечение chat_id
                const chatIdsUser1 = new Set(chatsUser1.map(c => c.chat_id));
                const chatIdsUser2 = new Set(chatsUser2.map(c => c.chat_id));
                const commonChatIds = [...chatIdsUser1].filter(id => chatIdsUser2.has(id));

                if (commonChatIds.length === 0) {
                    return res.status(403).json({
                        success: false,
                        message: "Вы не являетесь участниками общего чата",
                    });
                }

                const chat_id = commonChatIds[0];

                // Удаляем сообщения из чата
                const { error: msgErr } = await supabase
                    .from("messages")
                    .delete()
                    .eq("chat_id", chat_id);
                if (msgErr) throw msgErr;

                // Удаляем участников чата
                const { error: memErr } = await supabase
                    .from("chat_members")
                    .delete()
                    .eq("chat_id", chat_id);
                if (memErr) throw memErr;

                // Удаляем сам чат
                const { error: chatDeleteErr } = await supabase
                    .from("chats")
                    .delete()
                    .eq("id", chat_id);
                if (chatDeleteErr) throw chatDeleteErr;
            }
            else if (goal === "post") {
                const { error } = await supabase
                    .from("posts")
                    .delete()
                    .eq("id", delete_id)
                    .eq("user_id", user_id);

                if (error) throw error;
            }

            res.status(200).json({ success: true });
        } catch (err) {
            console.error("Ошибка при удалении:", err);
            res.status(500).json({ success: false, message: err.message });
        }
    });
}
