import { authenticateUser } from "./middleware/token.js";
import { hasServerPermission } from "./funcs/hasPermission.js";
import { PERMS } from "./PERMS.js";

export default function(app, supabase) {
  app.post("/updategroup", authenticateUser(supabase), async (req, res) => {
    try {
      const userId = req.user.id;
      const { group: groupIdRaw, updates } = req.body;

      if (!groupIdRaw) return res.status(400).json({ success: false, error: "Не указан ID группы" });
      if (!updates || !Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({ success: false, error: "Нет данных для обновления" });
      }

      const groupId = parseInt(groupIdRaw, 10);
      if (isNaN(groupId)) return res.status(400).json({ success: false, error: "Некорректный ID группы" });

      const { data: chatData, error: chatError } = await supabase
        .from("chats")
        .select("id, is_group")
        .eq("id", groupId)
        .single();

      if (chatError || !chatData || !chatData.is_group) {
        return res.status(404).json({ success: false, error: "Группа не найдена" });
      }

      // Маппинг полей
      const fieldMap = new Map([
        ["username", "name"],
        ["desc", "desc"]
      ]);

      const updateObj = {};
      let needsNamePerm = false;
      let needsDescPerm = false;

      for (const item of updates) {
        if (!item || typeof item.row !== "string") continue;

        const dbColumn = fieldMap.get(item.row);
        if (!dbColumn) continue;

        let value = item.value ?? null;

        if (dbColumn === "name") {
          if (typeof value !== "string" || value.trim() === "") {
            return res.status(400).json({ success: false, error: "Название группы не может быть пустым" });
          }
          value = value.trim();
          needsNamePerm = true;
        }

        if (dbColumn === "desc") {
          needsDescPerm = true;
        }

        updateObj[dbColumn] = value;
      }

      if (Object.keys(updateObj).length === 0) {
        return res.status(400).json({ success: false, error: "Нет валидных полей для обновления" });
      }

      // Проверка прав на каждое поле
      if (needsNamePerm && !(await hasServerPermission(supabase, groupId, userId, PERMS.change_name))) {
        return res.status(403).json({ success: false, error: "Нет прав на изменение названия" });
      }

      if (needsDescPerm && !(await hasServerPermission(supabase, groupId, userId, PERMS.change_desc))) {
        return res.status(403).json({ success: false, error: "Нет прав на изменение описания" });
      }

      // Системное сообщение (без имён)
      const changes = [];
      if ('name' in updateObj) changes.push("название");
      if ('desc' in updateObj) changes.push("описание");

      if (changes.length > 0) {
        const content = changes.length === 1 
          ? `обновил ${changes[0]} беседы`
          : `обновил ${changes.join(" и ")} беседы`;

        await supabase.from("messages").insert({
          chat_id: groupId,
          sender_id: userId,
          content,
          is_system: true,
        });
      }

      const { error: updateError } = await supabase
        .from("chats")
        .update(updateObj)
        .eq("id", groupId);

      if (updateError) {
        console.error("[updategroup] update error:", updateError);
        return res.status(500).json({ success: false, error: "Ошибка при обновлении группы" });
      }

      broadcastGroupUpdated(groupId);
      res.json({ success: true });
    } catch (err) {
      console.error("[updategroup] unexpected error:", err);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}