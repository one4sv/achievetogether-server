import { authenticateUser } from "./middleware/token.js";
import multer from "multer"; // ← добавьте импорт
import crypto from "crypto";

const uploadNone = multer(); // ← инициализация multer
export default function (app, supabase) {
  app.get("/group/:id", authenticateUser(supabase), async (req, res) => {
    const { id: userId } = req.user;
    const groupId = req.params.id; // id группы (предполагаем, что это chat_id группового чата)

    try {
      // 1. Проверка участия в группе
      const { data: currentMember, error: memberError } = await supabase
        .from("chat_members")
        .select("id")
        .eq("chat_id", groupId)
        .eq("user_id", userId)
        .single();

      if (memberError || !currentMember) {
        return res.status(403).json({ success: false, error: "Нет доступа к группе" });
      }

      // 2. Информация о группе (предполагаем, что в таблице chats есть поле desc)
      const { data: group, error: groupError } = await supabase
        .from("chats")
        .select("id, name, avatar_url, desc, invite_token, invite_expires_at")
        .eq("id", groupId)
        .single();

      if (groupError || !group) {
        return res.status(404).json({ success: false, error: "Группа не найдена" });
      }

      const CLIENT_URL = process.env.CLIENT_URL;
      const inviteLink = group.invite_token 
        ? `${CLIENT_URL}/join/${group.invite_token}` 
        : null;

      // 3. Участники группы (с role из chat_members)
      const { data: groupMembers } = await supabase
        .from("chat_members")
        .select("user_id, role")
        .eq("chat_id", groupId);

      const memberUserIds = groupMembers?.map(m => m.user_id) || [];

      const { data: memberUsers } = await supabase
        .from("users")
        .select("id, username, nick, avatar_url, last_online")
        .in("id", memberUserIds);

      const members = (memberUsers || []).map(u => {
        const gm = groupMembers.find(g => g.user_id === u.id);
        return {
          id: u.id,
          name: u.username || null,
          nick: u.nick,
          avatar_url: u.avatar_url || null,
          role: gm?.role || null,
          last_online: u.last_online || null,
        };
      });

      // 4. Привычки группы (предполагаем поле group_id в таблице habits; для личных — group_id null)
      const { data: habits } = await supabase
        .from("habits")
        .select("*")
        .eq("group_id", groupId);

      // 5. Медиа-файлы из сообщений группы (все файлы, newest first, как в /acc/:nick)
      const { data: messageIdsData } = await supabase
        .from("messages")
        .select("id")
        .eq("chat_id", groupId);

      const messageIds = messageIdsData?.map(m => m.id) || [];

      let media = [];
      if (messageIds.length > 0) {
        const { data: files } = await supabase
          .from("message_files")
          .select("file_url, file_name, file_type, message_id")
          .in("message_id", messageIds)
          .order("created_at", { ascending: false });

        media = (files || []).map(f => ({
          url: f.file_url,
          name: f.file_name,
          type: f.file_type,
          message_id: f.message_id.toString(),
        }));
      }

      // 6. Ответ (acc — как в /acc/:nick, чтобы совпадало с GroupProvider)
      res.json({
        success: true,
        group: {
          id: group.id,
          name: group.name,
          desc: group.desc || null,
          avatar_url: group.avatar_url || null,
          link: inviteLink,
          invite_expires_at: group.invite_expires_at || null,
        },
        habits: habits || [],
        members,
        media,
      });
    } catch (err) {
      console.error("Ошибка в /group/:id:", err);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
  app.post("/group/generate_link", authenticateUser(supabase), async (req, res) => {
    try {
      const userId = req.user.id;
      const { group_id } = req.body;

      if (!group_id) {
        return res.status(400).json({ success: false, error: "Не указан group_id" });
      }

      const groupId = parseInt(group_id, 10);
      if (isNaN(groupId)) {
        return res.status(400).json({ success: false, error: "Некорректный group_id" });
      }

      // Проверка, что пользователь — admin группы
      // const { data: member, error: memberError } = await supabase
      //   .from("chat_members")
      //   .select("role")
      //   .eq("chat_id", groupId)
      //   .eq("user_id", userId)
      //   .single();

      // if (memberError || !member || member.role !== "admin") {
      //   return res.status(403).json({ success: false, error: "Только администратор может генерировать ссылку" });
      // }

      // Генерация нового токена
      const token = crypto.randomUUID();

      // Срок действия — 24 часа
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 1);

      // Обновляем в БД (перезаписываем старую ссылку)
      const { error: updateError } = await supabase
        .from("chats")
        .update({
          invite_token: token,
          invite_expires_at: expiresAt.toISOString(),
        })
        .eq("id", groupId);

      if (updateError) {
        console.error("[generate_link] Ошибка обновления:", updateError);
        return res.status(500).json({ success: false, error: "Ошибка сохранения ссылки" });
      }

      const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
      const fullLink = `${FRONTEND_URL}/join/${token}`;

      return res.json({ success: true, link: fullLink });
    } catch (err) {
      console.error("[generate_link] unexpected error:", err);
      return res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  })
  app.get("/group/invite/:token", async (req, res) => {
    try {
      const { token } = req.params;

      const { data: group, error } = await supabase
        .from("chats")
        .select("id, name, avatar_url, desc, invite_token, invite_expires_at")
        .eq("invite_token", token)
        .single();

      if (error || !group || !group.invite_token) {
        return res.status(404).json({ success: false, error: "Приглашение не найдено" });
      }

      if (group.invite_expires_at && new Date(group.invite_expires_at) < new Date()) {
        return res.status(410).json({ success: false, error: "Приглашение истекло" });
      }

      // Количество участников
      const { count: memberCount } = await supabase
        .from("chat_members")
        .select("id", { count: "exact" })
        .eq("chat_id", group.id);

      res.json({
        success: true,
        group: {
          id: group.id,
          name: group.name,
          avatar_url: group.avatar_url,
          desc: group.desc || null,
          member_count: memberCount || 0,
        },
      });
    } catch (err) {
      console.error("[invite info] error:", err);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
  app.post("/group/join", authenticateUser(supabase), async (req, res) => {
    try {
      const userId = req.user.id;
      const { token } = req.body;

      if (!token) {
        return res.status(400).json({ success: false, error: "Токен не указан" });
      }

      // Находим группу по токену
      const { data: group, error: groupError } = await supabase
        .from("chats")
        .select("id, invite_expires_at")
        .eq("invite_token", token)
        .single();

      if (groupError || !group) {
        return res.status(404).json({ success: false, error: "Приглашение не найдено" });
      }

      if (group.invite_expires_at && new Date(group.invite_expires_at) < new Date()) {
        return res.status(410).json({ success: false, error: "Приглашение истекло" });
      }

      const chatId = group.id;

      // Проверяем, не состоит ли уже
      const { data: existing } = await supabase
        .from("chat_members")
        .select("id")
        .eq("chat_id", chatId)
        .eq("user_id", userId)
        .single();

      if (existing) {
        return res.json({ success: true, already_member: true, chat_id: chatId });
      }

      // Добавляем в участники
      const { error: joinError } = await supabase
        .from("chat_members")
        .insert({
          chat_id: chatId,
          user_id: userId,
          joined_at: new Date().toISOString(),
          role: null, // обычный участник
        });

      if (joinError) {
        console.error("[join] error:", joinError);
        return res.status(500).json({ success: false, error: "Не удалось вступить" });
      }

      // Системное сообщение
      const { data: user } = await supabase.from("users").select("username").eq("id", userId).single();

      await supabase.from("messages").insert({
        chat_id: chatId,
        sender_id: userId,
        content: `${user.username} присоединился по приглашению`,
        is_system: true,
        created_at: new Date().toISOString(),
      });

      res.json({ success: true, chat_id: chatId });
    } catch (err) {
      console.error("[join] unexpected:", err);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
  app.post("/group/addusers", authenticateUser(supabase), uploadNone.none(), async (req, res) => {
    try {
      console.log("[addusers] called, user:", req.user?.id);
      console.log("[addusers] req.body:", req.body); // для отладки

      // Защита от undefined
      if (!req.body) {
        return res.status(400).json({ success: false, error: "Нет данных в запросе" });
      }

      let { group_id: groupIdRaw, members: membersJson } = req.body;

      if (!groupIdRaw || !membersJson) {
        return res.status(400).json({ success: false, error: "Не указаны group_id или members" });
      }

      const groupId = parseInt(groupIdRaw, 10);
      if (isNaN(groupId)) {
        return res.status(400).json({ success: false, error: "Некорректный group_id" });
      }

      let memberIds = [];
      try {
        memberIds = JSON.parse(membersJson);
        if (!Array.isArray(memberIds) || memberIds.length === 0) {
          return res.status(400).json({ success: false, error: "Список участников пустой или некорректный" });
        }
      } catch (err) {
        return res.status(400).json({ success: false, error: "Некорректный формат members" });
      }

      const adminId = req.user.id;

      // Проверка admin
      const { data: adminCheck, error: adminError } = await supabase
        .from("chat_members")
        .select("role")
        .eq("chat_id", groupId)
        .eq("user_id", adminId)
        .single();

      if (adminError || !adminCheck || adminCheck.role !== "admin") {
        return res.status(403).json({ success: false, error: "Только администратор может добавлять участников" });
      }

      // Проверка пользователей
      const { data: usersToAdd, error: usersError } = await supabase
        .from("users")
        .select("id, username")
        .in("id", memberIds);

      if (usersError || !usersToAdd || usersToAdd.length !== memberIds.length) {
        return res.status(404).json({ success: false, error: "Один или несколько пользователей не найдены" });
      }

      // Username админа
      const { data: adminUser } = await supabase
        .from("users")
        .select("username")
        .eq("id", adminId)
        .single();

      const adminName = adminUser?.username || "Администратор";

      // Уже в группе?
      const { data: existingMembers } = await supabase
        .from("chat_members")
        .select("user_id")
        .eq("chat_id", groupId)
        .in("user_id", memberIds);

      const existingIds = new Set(existingMembers?.map(m => m.user_id) || []);

      const newMembers = usersToAdd.filter(u => !existingIds.has(u.id));

      if (newMembers.length === 0) {
        return res.json({ success: true, added: 0, message: "Все выбранные пользователи уже в группе" });
      }

      // Добавляем
      const inserts = newMembers.map(u => ({
        chat_id: groupId,
        user_id: u.id,
        joined_at: new Date().toISOString(),
        role: null
      }));

      const { error: insertError } = await supabase
        .from("chat_members")
        .insert(inserts);

      if (insertError) {
        console.error("[addusers] insert error:", insertError);
        return res.status(500).json({ success: false, error: "Не удалось добавить участников" });
      }

      // Системные сообщения
      const sysMessages = newMembers.map(u => ({
        chat_id: groupId,
        sender_id: adminId,
        content: `${adminName} добавил ${u.username} в группу`,
        is_system: true,
        created_at: new Date().toISOString()
      }));

      const { error: msgError } = await supabase
        .from("messages")
        .insert(sysMessages);

      if (msgError) {
        console.warn("[addusers] Не удалось добавить системные сообщения:", msgError);
      }

      return res.json({ success: true, added: newMembers.length });
    } catch (err) {
      console.error("[addusers] unexpected error:", err);
      return res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}


