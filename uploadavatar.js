import multer from "multer";
import path from "path";
import { authenticateUser } from "./middleware/token.js";
import { hasServerPermission } from "./funcs/hasPermission.js";
import { PERMS } from "./PERMS.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

export default function(app, supabase) {
  app.post("/uploadavatar", authenticateUser(supabase), upload.single("avatar"), async (req, res) => {
    try {
      const file = req.file;
      const groupIdRaw = req.body.group;

      if (!file) return res.status(400).json({ success: false, error: "No file uploaded" });

      const userId = req.user.id;
      let isGroup = false;
      let entityId = userId;
      let bucket = "avatars";
      let table = "users";

      if (groupIdRaw !== undefined && groupIdRaw !== "") {
        const groupId = parseInt(groupIdRaw, 10);
        if (isNaN(groupId)) return res.status(400).json({ success: false, error: "Invalid group ID" });

        if (!(await hasServerPermission(supabase, groupId, userId, PERMS.change_avatar))) {
          return res.status(403).json({ success: false, error: "Нет прав для изменения аватарки группы" });
        }

        isGroup = true;
        entityId = groupId;
        bucket = "chat_avatars";
        table = "chats";
      }

      const ext = path.extname(file.originalname) || ".png";
      const filename = `${isGroup ? `group_${entityId}` : `user_${userId}`}_${Date.now()}${ext}`;

      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(filename, file.buffer, {
          contentType: file.mimetype,
          upsert: true
        });

      if (uploadError) {
        console.error("[uploadavatar] storage upload error:", uploadError);
        return res.status(500).json({ success: false, error: "Storage upload error" });
      }

      const { data: { publicUrl } } = supabase.storage.from(bucket).getPublicUrl(filename);

      const { error: updateError } = await supabase
        .from(table)
        .update({ avatar_url: publicUrl })
        .eq("id", entityId);

      if (updateError) {
        console.error("[uploadavatar] DB update error:", updateError);
        return res.status(500).json({ success: false, error: "DB update error" });
      }

      if (isGroup) {
        await supabase.from("messages").insert({
          chat_id: entityId,
          sender_id: userId,
          content: "обновил аватарку беседы",
          is_system: true,
        });

        broadcastGroupUpdated(entityId);
      }

      res.json({
        success: true,
        avatar_url: publicUrl,
      });
    } catch (err) {
      console.error("[uploadavatar] unexpected error:", err);
      res.status(500).json({ success: false, error: "Server error" });
    }
  });
}