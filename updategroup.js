import { authenticateUser } from "./middleware/token.js";

export default function(app, supabase) {
    app.post("/updategroup", authenticateUser(supabase), async (req, res) => {
        try {
            console.log("[updategroup] called, user:", req.user?.id);

            const userId = req.user.id;
            const { group: groupIdRaw, updates } = req.body;

            // Валидация входных данных
            if (!groupIdRaw) {
                return res.status(400).json({ success: false, error: "Не указан ID группы" });
            }
            if (!updates || !Array.isArray(updates) || updates.length === 0) {
                return res.status(400).json({ success: false, error: "Нет данных для обновления" });
            }

            const groupId = parseInt(groupIdRaw, 10);
            if (isNaN(groupId)) {
                return res.status(400).json({ success: false, error: "Некорректный ID группы" });
            }

        // Проверка существования группы и что это именно группа (is_group = true)
            const { data: chatData, error: chatError } = await supabase
                .from("chats")
                .select("id, is_group")
                .eq("id", groupId)
                .single();

            if (chatError || !chatData || !chatData.is_group) {
                console.warn("[updategroup] Группа не найдена или это не группа:", groupId);
                return res.status(404).json({ success: false, error: "Группа не найдена" });
            }

        // Проверка прав: пользователь должен быть admin этой группы
            const { data: memberData, error: memberError } = await supabase
                .from("chat_members")
                .select("role")
                .eq("chat_id", groupId)
                .eq("user_id", userId)
                .single();

            if (memberError || !memberData || memberData.role !== "admin") {
                console.warn("[updategroup] Доступ запрещён: пользователь не admin группы", groupId, userId);
                return res.status(403).json({ success: false, error: "У вас нет прав для редактирования этой группы" });
            }

        // Whitelist полей и маппинг (чтобы не ломать текущий фронтенд, где используется "username")
            const fieldMap = new Map([
                ["username", "name"],   // фронтенд шлёт "username" → сохраняем в "name"
                ["desc", "desc"]
            ]);

            const updateObj = {};
            for (const item of updates) {
                if (!item || typeof item.row !== "string") continue;

                const dbColumn = fieldMap.get(item.row);
                if (!dbColumn) continue; // игнорируем неизвестные поля

                let value = item.value ?? null;

                // Дополнительная валидация для имени (аналогично createchat)
                if (dbColumn === "name") {
                    if (typeof value !== "string" || value.trim() === "") {
                        return res.status(400).json({ success: false, error: "Название группы не может быть пустым" });
                    }
                    value = value.trim();
                }

                updateObj[dbColumn] = value;
            }

            if (Object.keys(updateObj).length === 0) {
                    return res.status(400).json({ success: false, error: "Нет валидных полей для обновления" });
            }

            console.log("[updategroup] updating group", groupId, "with", updateObj);

            const { data: oldGroup, error: oldError } = await supabase
                .from("chats")
                .select("name, desc")
                .eq("id", groupId)
                .single();

            if (oldError || !oldGroup) {
                return res.status(500).json({ success: false, error: "Не удалось получить текущие данные группы" });
            }
            const changes = [];

            if ('name' in updateObj) {
                changes.push(`название на "${updateObj.name}"`);
            }

            if ('desc' in updateObj) {
                const newDesc = updateObj.desc ?? "";
                const trimmed = newDesc.trim();
                if (trimmed === "") {
                    changes.push("описание (очистил)");
                } else {
                    changes.push("описание");
                }
            }

            if (changes.length > 0) {
                let content;
                if (changes.length === 1) {
                    content = `обновил ${changes[0]} беседы`;
                } else {
                    // Для нескольких: "изменил название на "X", описание и аватарку"
                    const last = changes.pop();
                    content = `обновил ${changes.join(", ")} и ${last}`;
                }

                const { error: msgError } = await supabase
                    .from("messages")
                    .insert({
                    chat_id: groupId,
                    sender_id: userId,
                    content: content,
                    is_system: true,
                    created_at: new Date().toISOString()
                    });

                if (msgError) {
                    console.warn("[updategroup] Не удалось добавить системное сообщение:", msgError);
                    // Не прерываем основной успех — обновление уже прошло
                }
            }

            // Обновление в таблице chats
            const { data: updatedGroup, error: updateError } = await supabase
                .from("chats")
                .update(updateObj)
                .eq("id", groupId)
                .select()
                .single();
                

            if (updateError) {
                console.error("[updategroup] Supabase update error:", updateError);
                return res.status(500).json({ success: false, error: "Ошибка при обновлении группы", detail: updateError });
            }
            return res.json({ success: true, group: updatedGroup });
        } catch (err) {
            console.error("[updategroup] unexpected error:", err);
            return res.status(500).json({ success: false, error: "Ошибка сервера", detail: String(err) });
        }
    });
}