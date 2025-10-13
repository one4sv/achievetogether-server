import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
    app.post("/delete", authenticateUser(supabase), async (req, res) => {
        const { goal, delete_id } = req.body; // delete_id = id чата или привычки
        const { id: user_id } = req.user;

        try {
            if (goal === "habit") {
                // удалить привычку конкретного пользователя
                const { error } = await supabase
                    .from("habits")
                    .delete()
                    .eq("id", delete_id)
                    .eq("user_id", user_id);

                if (error) throw error;
            } else if (goal === "chat") {
                // проверяем, что пользователь участник чата
                const { data: member, error: memberErr } = await supabase
                    .from("chat_members")
                    .select("chat_id")
                    .eq("chat_id", delete_id)
                    .eq("user_id", user_id)
                    .single();

                if (memberErr || !member) {
                    return res.status(403).json({
                        success: false,
                        message: "Вы не являетесь участником этого чата",
                    });
                }

                // сначала удалить сообщения
                const { error: msgErr } = await supabase
                    .from("messages")
                    .delete()
                    .eq("chat_id", delete_id);

                if (msgErr) throw msgErr;

                // удалить участников
                const { error: memErr } = await supabase
                    .from("chat_members")
                    .delete()
                    .eq("chat_id", delete_id);

                if (memErr) throw memErr;

                // удалить сам чат
                const { error: chatErr } = await supabase
                    .from("chats")
                    .delete()
                    .eq("id", delete_id);

                if (chatErr) throw chatErr;
            }

            res.status(200).json({ success: true });
        } catch (err) {
            console.error("Ошибка при удалении:", err);
            res.status(500).json({ success: false, message: err.message });
        }
    });
}
