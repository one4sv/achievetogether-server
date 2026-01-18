import { authenticateUser } from "./middleware/token.js";
import multer from "multer";
import crypto from "crypto";
import path from "path";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB, как в примере uploadavatar
});

export default function (app, supabase) {
  app.post("/createchat", authenticateUser(supabase), (req, res, next) => {
    upload.single("pick")(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        console.error("[createchat] MulterError:", err.code, err.field, err.message);
        if (err.code === "LIMIT_UNEXPECTED_FILE") {
          return res.status(400).json({ success: false, error: `Неожиданное поле: ${err.field || "неизвестно"}. Ожидается поле 'pick' для файла.` });
        }
        return res.status(400).json({ success: false, error: `Ошибка Multer: ${err.message}` });
      } else if (err) {
        console.error("[createchat] Неизвестная ошибка в upload:", err);
        return res.status(500).json({ success: false, error: "Ошибка обработки файла" });
      }
      next();
    });
  }, async (req, res) => {
    try {
      console.log("[createchat] called, user:", req.user?.id);
      const { id: creatorId } = req.user;
      const { name, desc, members } = req.body;
      const avatarFile = req.file;

      console.log("[createchat] body:", { name, desc, members });
      if (avatarFile) {
        console.log("[createchat] file:", { originalname: avatarFile.originalname, mimetype: avatarFile.mimetype, size: avatarFile.size });
      } else {
        console.log("[createchat] no file in request");
      }

      if (!name || name.trim() === "") {
        return res.status(400).json({ success: false, error: "Название чата обязательно" });
      }

      let parsedMembers = [];
      try {
        parsedMembers = JSON.parse(members);
        if (!Array.isArray(parsedMembers) || parsedMembers.length < 1) {
          return res.status(400).json({ success: false, error: "Выберите хотя бы одного участника" });
        }
      } catch (err) {
        console.error("[createchat] Ошибка парсинга members:", err);
        return res.status(400).json({ success: false, error: "Некорректный список участников" });
      }

      // Проверяем, что участники существуют
      const { data: users, error: usersError } = await supabase
        .from("users")
        .select("id")
        .in("id", parsedMembers);

      if (usersError || users.length !== parsedMembers.length) {
        console.error("[createchat] Ошибка проверки пользователей:", usersError);
        return res.status(404).json({ success: false, error: "Один или несколько участников не найдены" });
      }

      let avatarUrl = null;
      if (avatarFile) {
        const ext = path.extname(avatarFile.originalname);
        const uniqueName = crypto.randomUUID() + ext;
        const filePath = `chat_avatars/${uniqueName}`;
        const bucket = "chat_avatars";
        const { error: uploadError } = await supabase.storage
          .from(bucket)
          .upload(filePath, avatarFile.buffer, { contentType: avatarFile.mimetype });
        if (uploadError) {
          console.error("[createchat] Ошибка загрузки аватара:", uploadError);
          throw uploadError;
        }
        const { data: { publicUrl } } = supabase.storage
          .from(bucket)
          .getPublicUrl(filePath);
        avatarUrl = publicUrl;
        console.log("[createchat] avatarUrl:", avatarUrl);
      }

      // Создаём чат
      const { data: newChat, error: chatError } = await supabase
        .from("chats")
        .insert({
          name: name.trim(),
          desc: desc ? desc.trim() : null,
          avatar_url: avatarUrl,
          creator_id: creatorId,
          is_group: true,
        })
        .select("id")
        .single();

      if (chatError || !newChat) {
        console.error("[createchat] Ошибка создания чата:", chatError);
        throw chatError || new Error("Не удалось создать чат");
      }

      const chatId = newChat.id;
      console.log("[createchat] new chatId:", chatId);

      // Добавляем участников, включая создателя
      const allMembers = [...new Set([creatorId, ...parsedMembers])];
      const chatMembers = allMembers.map(userId => ({
        chat_id: chatId,
        user_id: userId,
        joined_at: new Date().toISOString(),
        role: userId === creatorId ? 'admin' : null
      }));

      const { error: membersError } = await supabase
        .from("chat_members")
        .insert(chatMembers);

      if (membersError) {
        console.error("[createchat] Ошибка добавления участников:", membersError);
        // Rollback
        await supabase.from("chats").delete().eq("id", chatId);
        throw membersError;
      }

      // Системное сообщение
      const { error: sysMsgError } = await supabase.from("messages").insert({
        chat_id: chatId,
        sender_id: creatorId,
        content: `Чат "${name}" создан`,
        is_system: true,
        created_at: new Date().toISOString()
      });
      if (sysMsgError) {
        console.warn("[createchat] Ошибка системного сообщения:", sysMsgError);
      }

      res.json({ success: true, chat_id: chatId });
    } catch (err) {
      console.error("[createchat] Неожиданная ошибка:", err);
      res.status(500).json({ success: false, error: "Ошибка сервера", detail: err.message });
    }
  });
}