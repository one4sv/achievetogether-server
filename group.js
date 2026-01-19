import { authenticateUser } from "./middleware/token.js";

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
        .select("id, name, avatar_url, desc")
        .eq("id", groupId)
        .single();

      if (groupError || !group) {
        return res.status(404).json({ success: false, error: "Группа не найдена" });
      }

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
        acc: {
          id: group.id,
          name: group.name,
          desc: group.desc || null,
          avatar_url: group.avatar_url || null,
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
}