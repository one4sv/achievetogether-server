import { authenticateUser } from "./middleware/token.js";
import multer from "multer";
import { broadcastNewMessage, broadcastMessageRead } from "./ws.js";
import crypto from "crypto";
import path from "path";
import { BotInit } from "./bot.js";

export default function (app, supabase) {
  const upload = multer({ storage: multer.memoryStorage() });
  // Проверка API
  app.get("/chat", (req, res) => {
    res.send("Chat api is working...");
  });
  // Получить чат и сообщения (обновлено для файлов в сообщениях)
  app.get("/chat/:nick", authenticateUser(supabase), async (req, res) => {
    const { id } = req.user; // текущий пользователь
    const chatWithNick = req.params.nick; // собеседник

    try {
      // Проверяем существование собеседника
      const { data: chatWith, error: userError } = await supabase
        .from("users")
        .select("id, username, nick, avatar_url, last_online")
        .eq("nick", chatWithNick)
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
        .eq("user_id", chatWith.id);
      const theirChatIds = theirChats?.map(c => c.chat_id) || [];
      // Находим общий чат
      const chatId = myChatIds.find(chatId => theirChatIds.includes(chatId));
      let messages = [];
      let chatMember = { note: null, pinned: false, is_blocked: false };

      if (chatId) {
        const { data: cm, error: cmError } = await supabase
          .from("chat_members")
          .select("note, pinned, is_blocked")
          .eq("chat_id", chatId)
          .eq("user_id", id)
          .single();

        if (cmError) {
          console.error("Ошибка при получении chat_members:", cmError);
        }
          
        chatMember = cm || chatMember;

        const {data: am_i_blocked_data, error: am_i_blocked_error} = await supabase
          .from("chat_members")
          .select("is_blocked")
          .eq("chat_id", chatId)
          .eq("user_id", chatWith.id)

        if (am_i_blocked_error) {
          console.error("Ошибка при получении am_i_blocked:", am_i_blocked_error);
        }

        chatWith.am_i_blocked = am_i_blocked_data && am_i_blocked_data.length > 0 ? am_i_blocked_data[0].is_blocked : false;
        
        const { data: msgs } = await supabase
          .from("messages")
          .select(`
            id,
            sender_id,
            content,
            created_at,
            read_by,
            reactions,
            message_files (file_url, file_name, file_type),
            answer_id
          `)
          .eq("chat_id", chatId)
          .not('hidden', 'cs', `{"${id}"}`)  // для uuid[] оператор cs ожидает PostgreSQL массив синтаксис
          .order("created_at", { ascending: true });
        // Преобразование для клиента
        messages = (msgs || []).map(msg => ({
          ...msg,
          read_by: msg.read_by || [], // ← защита от undefined
          files: msg.message_files
            ? msg.message_files.map(f => ({
                url: f.file_url,
                name: f.file_name,
                type: f.file_type
              }))
            : []
        }));
      }
      // В endpoint /chat/:id после получения сообщений
      const messagesToUpdate = messages.filter(
        m => m.sender_id !== id && !m.read_by.includes(id)
      );
      if (messagesToUpdate.length > 0) {
        for (const m of messagesToUpdate) {
          await supabase
            .from("messages")
            .update({ read_by: [...m.read_by, id] })
            .eq("id", m.id);
         
          broadcastMessageRead(chatId, m.id, id);
        }
      }
      res.json({
        success: true,
        user: {
          id:chatWith.id,
          username: chatWith.username,
          avatar_url: chatWith.avatar_url,
          last_online: chatWith.last_online,
          note: chatMember.note,
          is_blocked: chatMember.is_blocked,
          pinned: chatMember.pinned,
          am_i_blocked:chatWith.am_i_blocked
        },
        messages,
      });
    } catch (err) {
      console.error("Ошибка запроса к Supabase:", err);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
  // Отправка сообщения (с поддержкой файлов)
  app.post("/chat", authenticateUser(supabase), upload.array("files"), async (req, res) => {
    const { id } = req.user;
    const { receiver_nick, text, answer_id } = req.body;  // Изменено на receiver_nick
    const files = req.files || [];
    if ((!text || !text.trim()) && files.length === 0) {
      return res.status(400).json({ success: false, error: "Сообщение пустое" });
    }
    try {
      // Находим receiver_id по nick
      const { data: receiverUser, error: receiverError } = await supabase
        .from("users")
        .select("id")
        .eq("nick", receiver_nick)
        .single();
      if (receiverError || !receiverUser) {
        return res.status(404).json({ success: false, error: "Пользователь не найден" });
      }
      const receiver_id = receiverUser.id;

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
        .insert([{ chat_id: chatId, sender_id: id, content: text || "", answer_id: answer_id || null }])
        .select()
        .single();

      if (receiver_nick === "ATBot") {
        const bot = BotInit(supabase);
        bot.handleMessage({
          chatId,
          userMessage: text
        });
      }

      let filesData = [];
      if (files.length > 0) {
        for (const file of files) {
          const ext = path.extname(file.originalname); // Получаем расширение
          const uniqueName = crypto.randomUUID() + ext; // Генерируем уникальное имя с расширением
          const filePath = `${id}/${uniqueName}`;
          const { error: uploadError } = await supabase.storage
            .from("media")
            .upload(filePath, file.buffer, { contentType: file.mimetype });
          if (uploadError) {
            throw uploadError;
          }
          const { data: { publicUrl } } = supabase.storage
            .from("media")
            .getPublicUrl(filePath);
          filesData.push({
            message_id: message.id,
            file_url: publicUrl,
            file_name: file.originalname, // Оригинальное имя для клиента
            file_type: file.mimetype.substring(0, 50), // Обрезаем до 50 символов
            file_size: file.size
          });
        }
        const { error: insertError } = await supabase.from("message_files").insert(filesData);
        if (insertError) {
          console.error("Ошибка вставки файлов:", insertError);
          throw insertError;
        }
      }
      // Формируем сообщение с файлами
      const messageWithFiles = { ...message, files: filesData.map(f => ({ url: f.file_url, name: f.file_name, type: f.file_type })) };
      // Бродкаст через WS
      broadcastNewMessage(chatId, messageWithFiles);
      res.json({ success: true, message: messageWithFiles });
    } catch (err) {
      console.error("Ошибка при отправке сообщения:", err);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
  // Отметить сообщение как прочитанное
  app.post("/chat/read", authenticateUser(supabase), async (req, res) => {
    const { id } = req.user; // текущий пользователь
    const { messageId } = req.body;
    if (!messageId) {
      return res.status(400).json({ success: false, error: "messageId обязателен" });
    }
    try {
      const { data: msg, error: msgError } = await supabase
        .from("messages")
        .select("id, read_by, chat_id")
        .eq("id", messageId)
        .single();
      if (msgError || !msg) {
        return res.status(404).json({ success: false, error: "Сообщение не найдено" });
      }
      if (!msg.read_by.includes(id)) {
        await supabase
          .from("messages")
          .update({
            read_by: [...msg.read_by, id]
          })
          .eq("id", messageId);
        // Можно оповестить участников через WS
        broadcastMessageRead(msg.chat_id, messageId, id);
      }
      res.json({ success: true });
    } catch (err) {
      console.error("Ошибка при обновлении read_by:", err);
      res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}