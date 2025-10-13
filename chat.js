import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
  // Проверка API
  app.get("/chat", (req, res) => {
    res.send("Chat api is working...");
  });

  // Получить чат и сообщения
  app.get("/chat/:id", authenticateUser(supabase), async (req, res) => {
    const { id } = req.user; // текущий пользователь
    const chatWithId = req.params.id; // собеседник

    try {
      // Проверяем существование собеседника
      const { data: chatWith, error: userError } = await supabase
        .from("users")
        .select("id, username, nick, avatar_url, last_online")
        .eq("id", chatWithId)
        .single();

      if (userError || !chatWith) {
        return res
          .status(404)
          .json({ success: false, error: "Пользователь не найден" });
      }

      // Получаем чаты текущего пользователя
      const { data: myChats } = await supabase
        .from("chat_members")
        .select("chat_id")
        .eq("user_id", id);

      const myChatIds = myChats?.map(c => c.chat_id) || [];

      // Получаем чаты собеседника
      const { data: theirChats } = await supabase
        .from("chat_members")
        .select("chat_id")
        .eq("user_id", chatWithId);

      const theirChatIds = theirChats?.map(c => c.chat_id) || [];

      // Находим общий чат
      const chatId = myChatIds.find(chatId => theirChatIds.includes(chatId));

      let messages = [];
      if (chatId) {
        const { data: msgs } = await supabase
          .from("messages")
          .select("id, sender_id, content, created_at")
          .eq("chat_id", chatId)
          .order("created_at", { ascending: true });
        messages = msgs || [];
      }

      res.json({
        success: true,
        user: {
          username: chatWith.username,
          nick: chatWith.nick,
          avatar_url: chatWith.avatar_url,
          last_online:chatWith.last_online
        },
        messages,
      });
    } catch (err) {
      console.error("Ошибка запроса к Supabase:", err);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });

  // Отправка сообщения
  app.post("/chat", authenticateUser(supabase), async (req, res) => {
    const { id } = req.user;
    let { receiver_id, text } = req.body;

    if (!text) {
      return res.status(400).json({ success: false, error: "Текст пустой" });
    }

    try {
      // Чаты текущего пользователя
      const { data: myChats } = await supabase
        .from("chat_members")
        .select("chat_id")
        .eq("user_id", id);

      const myChatIds = myChats?.map(c => c.chat_id) || [];

      // Чаты получателя
      const { data: theirChats } = await supabase
        .from("chat_members")
        .select("chat_id")
        .eq("user_id", receiver_id);

      const theirChatIds = theirChats?.map(c => c.chat_id) || [];

      // Находим общий чат
      let chatId = myChatIds.find(chatId => theirChatIds.includes(chatId));

      // Если чата нет — создаём
      if (!chatId) {
        const { data: newChat } = await supabase
          .from("chats")
          .insert({})
          .select("id")
          .single();

        chatId = newChat.id;

        await supabase.from("chat_members").insert([
          { chat_id: chatId, user_id: id },
          { chat_id: chatId, user_id: receiver_id },
        ]);
      }

      // Добавляем сообщение
      const { data: message } = await supabase
        .from("messages")
        .insert([{ chat_id: chatId, sender_id: id, content: text }])
        .select()
        .single();

      res.json({ success: true, message });
    } catch (err) {
      console.error("Ошибка при отправке сообщения:", err);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}
