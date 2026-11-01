import { inviteGroupUsers, validUserIds } from "../../services/groupInvitations.js";
// createchat route (исправленный и доработанный)
import { authenticateUser } from "../../middleware/token.js";
import multer from "multer";
import crypto from "crypto";
import path from "path";
import { PERMS } from "../../config/permissions.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
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
      if (!req.user?.id) return res.status(401).json({ success: false, error: "Войдите в аккаунт" });
      const { id: creatorId } = req.user;
      const { name, desc, members } = req.body;
      const avatarFile = req.file;

      if (!name || name.trim() === "") {
        return res.status(400).json({ success: false, error: "Название чата обязательно" });
      }

      let parsedMembers = [];
      const activityId = req.body.habit_id === undefined ? null : Number(req.body.habit_id);
      if (activityId !== null && (!Number.isSafeInteger(activityId) || activityId <= 0)) {
        return res.status(400).json({ success: false, error: "Некорректная активность" });
      }
      let activity = null;
      if (activityId !== null) {
        const { data: found, error: activityError } = await supabase.from("habits")
          .select("id, user_id, chat_id").eq("id", activityId).maybeSingle();
        if (activityError) throw activityError;
        if (!found) return res.status(404).json({ success: false, error: "Активность не найдена" });
        if (found.user_id !== creatorId) return res.status(403).json({ success: false, error: "Только владелец может связать активность с беседой" });
        if (found.chat_id) return res.status(400).json({ success: false, error: "Активность уже привязана к беседе" });
        activity = found;
      }
      try {
        parsedMembers = JSON.parse(members || "[]");
        if (!Array.isArray(parsedMembers) || (parsedMembers.length && !validUserIds(parsedMembers))) {
          return res.status(400).json({ success: false, error: "Некорректный список участников" });
        }
      } catch (err) {
        return res.status(400).json({ success: false, error: "Некорректный список участников" });
      }

      if (activity) {
        const { data: accepted, error: acceptedError } = await supabase.from("habit_members")
          .select("user_id").eq("habit_id", activity.id).eq("status", "accepted");
        if (acceptedError) throw acceptedError;
        parsedMembers = (accepted || []).map(item => item.user_id);
      }
      parsedMembers = [...new Set(parsedMembers)].filter(id => id !== creatorId);
      if (!activity && !parsedMembers.length) return res.status(400).json({ success: false, error: "Выберите другого участника" });

      const { data: existingUsers, error: usersError } = parsedMembers.length
        ? await supabase.from("users").select("id").in("id", parsedMembers)
        : { data: [], error: null };

      if (usersError || !existingUsers || existingUsers.length !== parsedMembers.length) {
        return res.status(404).json({ success: false, error: "Один или несколько участников не найдены" });
      }

      let avatarUrl = null;
      if (avatarFile) {
        const ext = path.extname(avatarFile.originalname);
        const uniqueName = crypto.randomUUID() + ext;
        const filePath = `chat_avatars/${uniqueName}`;
        const { error: uploadError } = await supabase.storage
          .from("chat_avatars")
          .upload(filePath, avatarFile.buffer, { contentType: avatarFile.mimetype });

        if (uploadError) throw uploadError;

        const { data: urlData } = supabase.storage.from("chat_avatars").getPublicUrl(filePath);
        avatarUrl = urlData.publicUrl;
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

      if (chatError || !newChat) throw chatError || new Error("Не удалось создать чат");

      const chatId = newChat.id;

      // 1. Member (default)
      const { data: defaultRole } = await supabase
        .from("chat_roles")
        .insert({
          chat_id: chatId,
          name: "member",
          rank: 20,
          is_default: true,
          permissions: {
            [PERMS.redirect_messages]: true,
          },
          is_editable:true
        })
        .select("id")
        .single();

      // 2. Moderator
      await supabase.from("chat_roles").insert({
        chat_id: chatId,
        name: "moderator",
        rank: 50,
        permissions: {
          [PERMS.pin_messages]: true,
          [PERMS.redirect_messages]: true,
          [PERMS.delete_others]: true,
          [PERMS.kick_users]: true,
          [PERMS.can_invite_users]: true,
        },
          is_editable:true
      });

      // 3. Admin
      await supabase.from("chat_roles").insert({
        chat_id: chatId,
        name: "admin",
        rank: 80,
        permissions: {
          [PERMS.change_avatar]: true,
          [PERMS.change_name]: true,
          [PERMS.change_desc]: true,
          [PERMS.pin_messages]: true,
          [PERMS.redirect_messages]: true,
          [PERMS.delete_others]: true,
          [PERMS.manage_roles]: true,
          [PERMS.kick_users]: true,
          [PERMS.ban_users]: true,
          [PERMS.can_invite_users]: true,
        },
        is_editable:false,
        desc:"Полные права упраления беседой, права не могут быть изменены, не может быть переименована или удалена. "
      });

      // 4. Owner (для создателя)
      const { data: ownerRole } = await supabase
        .from("chat_roles")
        .insert({
          chat_id: chatId,
          name: "owner",
          rank: 100,
          is_default: false,
          permissions: {
            [PERMS.change_avatar]: true,
            [PERMS.change_name]: true,
            [PERMS.change_desc]: true,
            [PERMS.pin_messages]: true,
            [PERMS.redirect_messages]: true,
            [PERMS.delete_others]: true,
            [PERMS.manage_roles]: true,
            [PERMS.kick_users]: true,
            [PERMS.ban_users]: true,
            [PERMS.can_invite_users]: true,
          },
          is_editable:false,
          desc:`В беседе может быть только один владелец.
            Имеет наивысший приоритет, права не могут быть изменены, не может быть переименована или удалена.
            В случае выхода владельца его роль автоматически передаётся участнику с ролью следующего уровня приоритета, который дольше остальных находится в беседе.`
        })
        .select("id")
        .single();

      // Устанавливаем default роль
      await supabase
        .from("chats")
        .update({ default_role_id: defaultRole?.id })
        .eq("id", chatId);

      // Добавляем участников
      if (!defaultRole || !ownerRole) {
        await supabase.from("chats").delete().eq("id", chatId);
        throw new Error("Не удалось создать роли беседы");
      }
      const allMemberIds = [creatorId];

      const chatMembersInserts = allMemberIds.map(userId => ({
        chat_id: chatId,
        user_id: userId,
        role_id: userId === creatorId ? ownerRole.id : defaultRole.id,
      }));

      const { error: membersError } = await supabase
        .from("chat_members")
        .insert(chatMembersInserts);

      if (membersError) {
        await supabase.from("chats").delete().eq("id", chatId);
        throw membersError;
      }

      // Системное сообщение
      await supabase.from("messages").insert({
        chat_id: chatId,
        sender_id: creatorId,
        content: `создал беседу "${name}"`,
        is_system: true,
      });

      let invitations = { added: 0, invited: 0, blocked: 0, already: 0 };
      try {
        if (parsedMembers.length) {
          invitations = await inviteGroupUsers(supabase, creatorId, chatId, parsedMembers);
          if (activity && (invitations.blocked || (invitations.added || 0) + (invitations.invited || 0) + (invitations.already || 0) < parsedMembers.length)) {
            throw Object.assign(new Error("Не удалось пригласить участника активности"), { code: "42501" });
          }
        }
        if (activity) {
          const { data: linked, error: linkError } = await supabase.from("habits")
            .update({ chat_id: chatId }).eq("id", activity.id).eq("user_id", creatorId)
            .is("chat_id", null).select("id").maybeSingle();
          if (linkError || !linked) throw linkError || Object.assign(new Error("Активность уже привязана к другой беседе"), { code: "22023" });
        }
      } catch (error) {
        await supabase.from("chats").delete().eq("id", chatId);
        throw error;
      }
      res.json({ success: true, chat_id: chatId, ...invitations });
    } catch (err) {
      console.error("[createchat] Ошибка:", err);
      res.status(err.code === "42501" ? 403 : err.code === "22023" ? 400 : 500).json({ success: false, error: err.code === "42501" ? "Не удалось пригласить участника: проверьте права и приватность" : err.code === "22023" ? err.message : "Ошибка сервера" });
    }
  });
}