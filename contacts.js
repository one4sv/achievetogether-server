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
      const chatIds = chat_members?.map(c => c.chat_id) || [];

      let usersInChats = [];
      const lastMessages = {};

      if (chatIds.length > 0) {
        const { data: otherUsers } = await supabase
          .from("chat_members")
          .select("chat_id, user_id")
          .in("chat_id", chatIds)
          .neq("user_id", id);

        const uniqueUserIds = [...new Set(otherUsers.map(u => u.user_id))];

        if (uniqueUserIds.length > 0) {
          const { data: users } = await supabase
            .from("users")
            .select("id, username, nick, avatar_url")
            .in("id", uniqueUserIds);

          usersInChats = users || [];

          // Берём последние сообщения
          const { data: messages } = await supabase
            .from("messages")
            .select("id, chat_id, sender_id, content, created_at")
            .in("chat_id", chatIds)
            .order("created_at", { ascending: false });

          (messages || []).forEach(msg => {
            if (!lastMessages[msg.chat_id]) lastMessages[msg.chat_id] = msg;
          });

          // Добавляем lastMessage каждому пользователю
          usersInChats = usersInChats.map(user => {
            const chat = otherUsers.find(c => c.user_id === user.id);
            return {
              ...user,
              lastMessage: chat ? lastMessages[chat.chat_id] || null : null
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

        const existingIds = usersInChats.map(u => u.id);
        searchUsers = (users || [])
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
      res.status(500).json({ success: false, error: "Server error" });
    }
  });
}
