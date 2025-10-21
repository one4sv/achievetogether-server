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

      const chatIds = Array.isArray(chat_members) ? chat_members.map(c => c.chat_id) : [];

      let usersInChats = [];
      const lastMessages = {};

      if (chatIds.length > 0) {
        // Получаем всех участников этих чатов кроме текущего пользователя
        const { data: otherUsers } = await supabase
          .from("chat_members")
          .select("chat_id, user_id")
          .in("chat_id", chatIds)
          .neq("user_id", id);

        const safeOtherUsers = Array.isArray(otherUsers) ? otherUsers : [];

        // Уникальные пользователи
        const uniqueUserIds = [...new Set(safeOtherUsers.map(u => u.user_id))];

        if (uniqueUserIds.length > 0) {
          // Получаем данные пользователей
          const { data: users } = await supabase
            .from("users")
            .select("id, username, nick, avatar_url")
            .in("id", uniqueUserIds);

          usersInChats = Array.isArray(users) ? users : [];

          // Получаем последние сообщения
          const { data: messages } = await supabase
            .from("messages")
            .select("id, chat_id, sender_id, content, created_at, read_by")
            .in("chat_id", chatIds)
            .order("created_at", { ascending: false });

          const safeMessages = Array.isArray(messages) ? messages : [];
          const messageIds = safeMessages.map(m => m.id);

          // Получаем файлы сообщений
          const { data: files } = await supabase
            .from("message_files")
            .select("id, message_id, file_url, file_type, file_name, file_size")
            .in("message_id", messageIds);

          const safeFiles = Array.isArray(files) ? files : [];

          // Привязываем файлы к сообщениям
          const messagesWithFiles = safeMessages.map(msg => ({
            ...msg,
            files: safeFiles.filter(f => f.message_id === msg.id)
          }));

          // Берём последнее сообщение для каждого чата
          messagesWithFiles.forEach(msg => {
            if (!lastMessages[msg.chat_id]) lastMessages[msg.chat_id] = msg;
          });

          // Добавляем lastMessage и unread_count каждому пользователю
          usersInChats = usersInChats.map(user => {
            const chat = safeOtherUsers.find(c => c.user_id === user.id);
            const lastMessage = chat ? lastMessages[chat.chat_id] || null : null;

            let unread_count = 0;
            if (chat) {
              const chatMessages = messagesWithFiles.filter(
                m => m.chat_id === chat.chat_id && m.sender_id === user.id
              );
              unread_count = chatMessages.filter(m => !m.read_by.includes(id)).length;
            }

            return {
              ...user,
              lastMessage,
              unread_count
            };
          });
        }
      }

      // 2. Если есть поиск, фильтруем переписки по нему
      let filteredChats = usersInChats;
      let searchUsers = [];

      if (search && search.trim() !== "") {
        const lowerSearch = search.toLowerCase();

        // Фильтруем уже существующие переписки
        filteredChats = usersInChats.filter(u =>
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
          .map(u => ({ ...u, lastMessage: null }));
      }

      // 3. Формируем финальный массив
      const friendsArr = (search && search.trim() !== "")
        ? [...filteredChats, ...searchUsers]
        : usersInChats;

      return res.json({ success: true, friendsArr });
    } catch (err) {
      console.error("Failed supabase request:", err);
      return res.status(500).json({ success: false, error: "Server error" });
    }
  });
}
