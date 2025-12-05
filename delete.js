import { authenticateUser } from "./middleware/token.js";
import { broadcastMessageDeleted } from "./ws.js";

export default function (app, supabase) {
    app.post("/delete", authenticateUser(supabase), async (req, res) => {
        const { goal, delete_id } = req.body;
        const { id: user_id } = req.user;

        if (!goal || !delete_id) {
            return res.status(400).json({ success: false, message: "goal и delete_id обязательны" });
        }

        try {
            if (goal === "habit") {
                const { data, error } = await supabase
                    .from("habits")
                    .delete()
                    .eq("id", Number(delete_id))
                    .eq("user_id", user_id)
                    .select()
                    .single();

                if (error || !data) {
                    return res.status(404).json({ success: false, message: "Привычка не найдена или нет доступа" });
                }
            }
            else if (goal === "chat") {
                const { data: chatsUser1, error: err1 } = await supabase
                    .from("chat_members")
                    .select("chat_id")
                    .eq("user_id", user_id);

                if (err1 || !chatsUser1?.length) throw err1 || new Error("Нет чатов");

                const { data: chatsUser2, error: err2 } = await supabase
                    .from("chat_members")
                    .select("chat_id")
                    .eq("user_id", delete_id);

                if (err2 || !chatsUser2?.length) {
                    return res.status(404).json({ success: false, message: "Собеседник не найден" });
                }

                const commonChatId = chatsUser1.find(c => chatsUser2.some(c2 => c2.chat_id === c.chat_id))?.chat_id;

                if (!commonChatId) {
                    return res.status(403).json({ success: false, message: "Общий чат не найден" });
                }

                const { error: delMsgErr } = await supabase
                    .from("messages")
                    .delete()
                    .eq("chat_id", commonChatId);
                if (delMsgErr) throw delMsgErr;

                const { error: delMemErr } = await supabase
                    .from("chat_members")
                    .delete()
                    .eq("chat_id", commonChatId);
                if (delMemErr) throw delMemErr;

                const { error: delChatErr } = await supabase
                    .from("chats")
                    .delete()
                    .eq("id", commonChatId);
                if (delChatErr) throw delChatErr;
            }
            else if (goal === "post") {
                const { data, error } = await supabase
                    .from("posts")
                    .delete()
                    .eq("id", delete_id)
                    .eq("user_id", user_id)
                    .select()
                    .single();

                if (error || !data) {
                    return res.status(404).json({ success: false, message: "Пост не найден или нет доступа" });
                }
            }
            else if (goal === "mess" || goal === "messForAll") {
                const messageIds = Array.isArray(delete_id) ? delete_id : [delete_id];

                for (const msgId of messageIds) {
                    // Получаем сообщение
                    const { data: message, error: msgError } = await supabase
                        .from("messages")
                        .select("id, chat_id, hidden")
                        .eq("id", msgId)
                        .single();

                    if (msgError || !message) {
                        // Пропускаем несуществующие сообщения, но не прерываем цикл
                        continue;
                    }

                    // Проверяем, что пользователь — член чата сообщения
                    const { data: member, error: memError } = await supabase
                        .from("chat_members")
                        .select("user_id")
                        .eq("chat_id", message.chat_id)
                        .eq("user_id", user_id)
                        .single();

                    if (memError || !member) {
                        return res.status(403).json({ success: false, message: `Нет доступа к сообщению ${msgId}` });
                    }

                    if (goal === "messForAll") {
                        const { error } = await supabase
                            .from("messages")
                            .delete()
                            .eq("id", msgId);

                        if (error) {
                            return res.status(403).json({ success: false, message: `Нет доступа к сообщению ${msgId}` });
                        }
                        // Broadcast на удаление для всех
                        broadcastMessageDeleted(message.chat_id, msgId);
                    } else {
                        const alreadyHidden = message.hidden?.includes(user_id);

                        if (!alreadyHidden) {
                            const newHidden = Array.isArray(message.hidden) ? [...message.hidden, user_id] : [user_id];

                            const { error: updateError } = await supabase
                                .from("messages")
                                .update({ hidden: newHidden })
                                .eq("id", msgId);

                            if (updateError) throw updateError;

                            broadcastMessageDeleted(message.chat_id, msgId, user_id);
                        }
                    }
                }
            }
            else {
                return res.status(400).json({ success: false, message: "Неверный goal" });
            }

            return res.json({ success: true });
        } catch (err) {
            console.error("Ошибка в /delete:", err);
            return res.status(500).json({ success: false, message: err.message || "Внутренняя ошибка сервера" });
        }
    });
}
