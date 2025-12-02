import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
  app.post("/contacts", authenticateUser(supabase), async (req, res) => {
    const { id } = req.user;
    const { search } = req.body;

    try {
      // 1. Получаем все чаты текущего пользователя
      const { data: chat_members } = await supabase
        .from("chat_members")
        .select("chat_id")
        .eq("user_id", id);

      const chatIds = Array.isArray(chat_members)
        ? chat_members.map(c => c.chat_id)
        : [];

      if (chatIds.length === 0) {
        // Нет чатов — сразу возвращаем пустой массив
        return res.json({ success: true, friendsArr: [] });
      }

      // 2. Получаем настройки текущего пользователя (note, pinned, is_blocked) для всех этих чатов
      const { data: userChatSettings } = await supabase
        .from("chat_members")
        .select("chat_id, note, pinned, is_blocked")
        .eq("user_id", id)
        .in("chat_id", chatIds);

      // 3. Получаем всех участников этих чатов кроме текущего пользователя
      const { data: otherUsers } = await supabase
        .from("chat_members")
        .select("chat_id, user_id")
        .in("chat_id", chatIds)
        .neq("user_id", id);

      const safeOtherUsers = Array.isArray(otherUsers) ? otherUsers : [];

      // 4. Уникальные ID собеседников
      const uniqueUserIds = [...new Set(safeOtherUsers.map(u => u.user_id))];

      let usersInChats = [];
      const lastMessages = {};

      if (uniqueUserIds.length > 0) {
        // 5. Получаем данные пользователей-собеседников
        const { data: users } = await supabase
          .from("users")
          .select("id, username, nick, avatar_url")
          .in("id", uniqueUserIds);

        usersInChats = Array.isArray(users) ? users : [];

        // 6. Получаем последние сообщения для этих чатов
        const { data: messages } = await supabase
          .from("messages")
          .select("id, chat_id, sender_id, content, created_at, read_by")
          .in("chat_id", chatIds)
          .order("created_at", { ascending: false });

        const safeMessages = Array.isArray(messages) ? messages : [];
        const messageIds = safeMessages.map(m => m.id);

        // 7. Получаем файлы сообщений
        const { data: files } = await supabase
          .from("message_files")
          .select("id, message_id, file_url, file_type, file_name, file_size")
          .in("message_id", messageIds);

        const safeFiles = Array.isArray(files) ? files : [];

        // 8. Связываем файлы с сообщениями
        const messagesWithFiles = safeMessages.map(msg => ({
          ...msg,
          files: safeFiles.filter(f => f.message_id === msg.id),
        }));

        // 9. Берём последнее сообщение для каждого чата
        messagesWithFiles.forEach(msg => {
          if (!lastMessages[msg.chat_id]) lastMessages[msg.chat_id] = msg;
        });

        // 10. Формируем итоговый массив пользователей с нужными полями
        usersInChats = usersInChats.map(user => {
          // Находим чат, в котором этот собеседник и текущий пользователь вместе
          const chatEntry = safeOtherUsers.find(cu => cu.user_id === user.id);

          // Берём настройки текущего пользователя в этом чате
          const settings = userChatSettings.find(
            us => us.chat_id === chatEntry.chat_id
          );

          // Сообщения в чате от собеседника, для подсчёта непрочитанных
          const chatMessages = messagesWithFiles.filter(
            m => m.chat_id === chatEntry.chat_id && m.sender_id === user.id
          );

          // Считаем непрочитанные (не включают текущего пользователя в read_by)
          const unread_count = chatMessages.filter(
            m => !m.read_by.includes(id)
          ).length;

          return {
            ...user,
            lastMessage: lastMessages[chatEntry.chat_id] || null,
            unread_count,
            note: settings?.note ?? false,
            pinned: settings?.pinned ?? false,
            is_blocked: settings?.is_blocked ?? false,
          };
        });
      }

      // 11. Фильтрация по поиску
      let filteredChats = usersInChats;
      let searchUsers = [];

      if (search && search.trim() !== "") {
        const lowerSearch = search.toLowerCase();

        // Фильтруем текущие переписки
        filteredChats = usersInChats.filter(
          u =>
            (u.username && u.username.toLowerCase().includes(lowerSearch)) ||
            (u.nick && u.nick.toLowerCase().includes(lowerSearch))
        );

        // Ищем новых пользователей, которых ещё нет в переписках
        const { data: users } = await supabase
          .from("users")
          .select("id, username, nick, avatar_url")
          .or(`username.ilike.%${search}%,nick.ilike.%${search}%`)
          .neq("id", id);

        const safeUsers = Array.isArray(users) ? users : [];
        const existingIds = usersInChats.map(u => u.id);

        searchUsers = safeUsers
          .filter(u => !existingIds.includes(u.id))
          .map(u => ({
            ...u,
            lastMessage: null,
            unread_count: 0,
            note: true, // по умолчанию
            pinned: false,
            is_blocked: false,
          }));
      }
      // 12. Формируем финальный массив
      const friendsArr =
        search && search.trim() !== ""
          ? [...filteredChats, ...searchUsers]
          : usersInChats;

      return res.json({ success: true, friendsArr });
    } catch (err) {
      console.error("Failed supabase request:", err);
      return res.status(500).json({ success: false, error: "Server error" });
    }
  });
}
