import multer from "multer";
import path from "path";
import { authenticateUser } from "./middleware/token.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB
});

export default function(app, supabase) {
  app.post("/uploadavatar", authenticateUser(supabase), upload.single("avatar"), async (req, res) => {
    try {
      console.log("[uploadavatar] called, user:", req.user?.id);
      const file = req.file;
      const groupIdRaw = req.body.group;

      if (!file) {
        console.warn("[uploadavatar] no file in request");
        return res.status(400).json({ success: false, error: "No file uploaded" });
      }

      console.log("[uploadavatar] file:", { originalname: file.originalname, mimetype: file.mimetype, size: file.size });
      console.log("[uploadavatar] group param:", groupIdRaw);

      const userId = req.user.id;
      let isGroup = false;
      let entityId = userId;
      let bucket = "avatars";
      let table = "users";
      let filenamePrefix = `user_${userId}`;

      if (groupIdRaw !== undefined && groupIdRaw !== "") {
        const groupId = parseInt(groupIdRaw, 10);
        if (isNaN(groupId)) {
          return res.status(400).json({ success: false, error: "Invalid group ID" });
        }

        const { data: memberData, error: memberError } = await supabase
          .from("chat_members")
          .select("role")
          .eq("chat_id", groupId)
          .eq("user_id", userId)
          .single();

        if (memberError || !memberData || memberData.role !== "admin") {
          console.warn("[uploadavatar] Access denied for group", groupId, "user", userId);
          return res.status(403).json({ success: false, error: "Нет прав для изменения аватарки группы" });
        }

        isGroup = true;
        entityId = groupId;
        bucket = "chat_avatars";
        table = "chats";
        filenamePrefix = `group_${groupId}`;
      }

      const ext = path.extname(file.originalname) || ".png";
      const filename = `${filenamePrefix}_${Date.now()}${ext}`;
      const filePath = filename;

      // Загрузка в Storage
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(filePath, file.buffer, {
          contentType: file.mimetype,
          upsert: true
        });

      if (uploadError) {
        console.error("[uploadavatar] storage upload error:", uploadError);
        return res.status(500).json({ success: false, error: "Storage upload error", detail: uploadError });
      }

      // Публичный URL
      const publicRes = supabase.storage.from(bucket).getPublicUrl(filePath);
      const publicUrl = publicRes?.data?.publicUrl || publicRes?.publicUrl || publicRes?.data?.publicURL || publicRes?.publicURL;

      if (!publicUrl) {
        console.error("[uploadavatar] no publicUrl returned");
        return res.status(500).json({ success: false, error: "No public URL" });
      }

      // Получаем старый avatar_url только для группы (до обновления БД)
      let oldAvatarUrl = null;
      if (isGroup) {
        const { data: oldGroup, error: oldError } = await supabase
          .from("chats")
          .select("avatar_url")
          .eq("id", entityId)
          .single();

        if (!oldError && oldGroup && oldGroup.avatar_url) {
          oldAvatarUrl = oldGroup.avatar_url;
        }
        // Если oldError — просто считаем, что старой аватарки не было (не прерываем процесс)
      }

      // Обновляем БД
      const { data: updatedData, error: updateError } = await supabase
        .from(table)
        .update({ avatar_url: publicUrl })
        .eq("id", entityId)
        .select()
        .single();

      if (updateError) {
        console.error("[uploadavatar] DB update error:", updateError);
        return res.status(500).json({ success: false, error: "DB update error", detail: updateError });
      }

      // Системное сообщение только для группы
      if (isGroup) {
        const avatarContent = oldAvatarUrl 
          ? "изменил аватарку беседы" 
          : "установил аватарку беседы";

        const { error: msgError } = await supabase
          .from("messages")
          .insert({
            chat_id: entityId,
            sender_id: userId,
            content: avatarContent,
            is_system: true,
            created_at: new Date().toISOString()
          });

        if (msgError) {
          console.warn("[uploadavatar] Не удалось добавить системное сообщение:", msgError);
        }
      }

      return res.json({
        success: true,
        avatar_url: publicUrl,
        [isGroup ? "group" : "user"]: updatedData
      });
    } catch (err) {
      console.error("[uploadavatar] unexpected error:", err);
      return res.status(500).json({ success: false, error: "Server error", detail: String(err) });
    }
  });
}