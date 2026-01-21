import { authenticateUser } from "./middleware/token.js";
import { broadcastMessageDeleted, broadcastGroupUpdated, broadcastKicked } from "./ws.js";

export default function (app, supabase) {
    app.post("/delete", authenticateUser(supabase), async (req, res) => {
        const { goal, delete_id, group_id } = req.body;
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
            else if (goal === "member" || goal === "leave") {
                if (!group_id) {
                    return res.status(400).json({ success: false, error: "Не указан group_id" });
                }

                const groupId = parseInt(group_id, 10);
                if (isNaN(groupId)) {
                    return res.status(400).json({ success: false, error: "Некорректный group_id" });
                }

                let targetUserId = user_id; // по умолчанию — себя (leave)
                if (goal === "member") {
                    if (!delete_id) {
                        return res.status(400).json({ success: false, error: "Не указан user_id для исключения" });
                    }
                    targetUserId = delete_id; // чужой пользователь
                }

                // Проверка: текущий пользователь в группе
                const { data: currentMember, error: currError } = await supabase
                    .from("chat_members")
                    .select("role")
                    .eq("chat_id", groupId)
                    .eq("user_id", user_id)
                    .single();

                if (currError || !currentMember) {
                    return res.status(403).json({ success: false, error: "Вы не состоите в этой группе" });
                }

                const canKickMembers = ["admin", "moderator"].includes(currentMember.role);

                if (goal === "member" && !canKickMembers) {
                    return res.status(403).json({ success: false, error: "У вас нет прав для исключения участников"});
                }

                // Нельзя исключить/покинуть себя как админа без передачи прав (но для leave обработаем ниже)
                if (user_id === targetUserId && currentMember.role === "admin") {
                    // Найдём всех участников кроме себя, отсортированных по joined_at (самый старый первый)
                    const { data: otherMembers } = await supabase
                    .from("chat_members")
                    .select("user_id")
                    .eq("chat_id", groupId)
                    .neq("user_id", user_id)
                    .order("joined_at", { ascending: true })
                    .limit(1);

                    if (otherMembers && otherMembers.length > 0) {
                    // Передаём админку самому старому
                    await supabase
                        .from("chat_members")
                        .update({ role: "admin" })
                        .eq("chat_id", groupId)
                        .eq("user_id", otherMembers[0].user_id);
                    }
                    // Если никого не осталось — группа удалится ниже
                }

                // Удаляем целевого пользователя из группы
                const { error: deleteError } = await supabase
                    .from("chat_members")
                    .delete()
                    .eq("chat_id", groupId)
                    .eq("user_id", targetUserId);

                if (deleteError) {
                    console.error("[delete member/leave] delete error:", deleteError);
                    return res.status(500).json({ success: false, error: "Не удалось выйти/исключить" });
                }

                // Имя уходящего/исключённого
                const { data: targetUser } = await supabase
                    .from("users")
                    .select("username")
                    .eq("id", targetUserId)
                    .single();

                const targetName = targetUser?.username || "Пользователь";

                let actionText = ""
                let senderIdForMsg = goal === "leave" ? targetUserId : user_id; // системка от имени того, кто действие совершил

                if (goal === "member") {
                    actionText = `исключил ${targetName} из группы`;
                } else {
                    actionText = `покинул группу`;
                }

                // Системное сообщение (если в группе ещё кто-то остался)
                const { count: remainingMembers } = await supabase
                    .from("chat_members")
                    .select("id", { count: "exact" })
                    .eq("chat_id", groupId);

                const { data: groupData } = await supabase
                    .from("chats")
                    .select("name")
                    .eq("id", groupId)
                    .single();

                const groupName = groupData?.name || "группы";

                if (remainingMembers && remainingMembers > 0) {
                    await supabase.from("messages").insert({
                        chat_id: groupId,
                        sender_id: senderIdForMsg,
                        content: actionText,
                        is_system: true,
                        created_at: new Date().toISOString()
                    });
                    broadcastGroupUpdated(groupId); // обновление у оставшихся
                    
                } else {
                    await supabase.from("messages").delete().eq("chat_id", groupId);
                    await supabase.from("chats").delete().eq("id", groupId);
                }
                broadcastKicked({id: targetUserId, group_id: String(group_id), reason: goal, group_name: groupName})

                return res.json({ success: true });
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
