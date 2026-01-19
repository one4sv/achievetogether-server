import { authenticateUser } from "./middleware/token.js";
import multer from "multer";
import { broadcastNewMessage, broadcastMessageRead, broadcastMessageEdited } from "./ws.js"; // Добавьте broadcastMessageEdited в ws.js
import crypto from "crypto";
import path from "path";
import { BotInit } from "./bot.js";
import resolveOriginalRedirect from "./funcs/resolveRedirect.js";

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
            answer_id,
            edited,
            redirected_id,
            show_names,
            is_system
          `)
          .eq("chat_id", chatId)
          .not('hidden', 'cs', `{"${id}"}`) // для uuid[] оператор cs ожидает PostgreSQL массив синтаксис
          .order("created_at", { ascending: true });

        // ДОБАВЛЕНО: Fetch перенаправленных сообщений
        const redirectedIds = msgs
          .map(msg => msg.redirected_id)
          .filter(rId => rId !== null);
        const uniqueRedirectedIds = [...new Set(redirectedIds)];
        let redirectedMap = new Map();
        let redirectedMsgs = []; // ДОБАВЛЕНО: сохраняем для сбора sender_ids
        if (uniqueRedirectedIds.length > 0) {
          const { data, error: redirectedError } = await supabase
            .from("messages")
            .select(`
              id,
              sender_id,
              content,
              created_at,
              message_files (file_url, file_name, file_type),
              answer_id,
              edited,
              is_system
            `)
            .in("id", uniqueRedirectedIds);

          if (redirectedError) {
            console.error("Ошибка при получении перенаправленных сообщений:", redirectedError);
          } else {
            data.forEach(m => redirectedMap.set(m.id, m));
          }
          if (data) {
            for (const m of data) {
              if (m.redirected_id) {
                m.redirected_id = await resolveOriginalRedirect(supabase, m.redirected_id);
                // Также обновите content, files и т.д. из оригинала, если нужно
                const { data: original } = await supabase
                  .from("messages")
                  .select("content, answer_id, message_files (file_url, file_name, file_type), is_system")
                  .eq("id", m.redirected_id)
                  .single();
                if (original) {
                  m.content = original.content;
                  m.answer_id = original.answer_id;
                  m.message_files = original.message_files;
                }
              }
              redirectedMap.set(m.id, m);
            }
            redirectedMsgs = data;
          }
        }

        // ИЗМЕНЕНО: Собираем все уникальные sender_id из msgs и redirectedMsgs
        const allSenderIds = new Set();
        msgs.forEach(msg => allSenderIds.add(msg.sender_id));
        redirectedMsgs.forEach(m => allSenderIds.add(m.sender_id));
        allSenderIds.add(id); // Добавляем текущего пользователя на всякий случай
        allSenderIds.add(chatWith.id); // Добавляем собеседника

        // ИЗМЕНЕНО: Fetch пользователей по всем sender_ids
        const { data: users } = await supabase
          .from("users")
          .select("id, username, nick")
          .in("id", Array.from(allSenderIds));

        // Создаём словарь id => имя
        const userMap = {};
        const nickMap = {};
        (users || []).forEach(u => {
          userMap[u.id] = u.username || u.nick;
          nickMap[u.id] = u.nick;
        });

        // ИЗМЕНЕНО: Преобразование для клиента с добавлением перенаправленных данных (мапы теперь полные)
        messages = (msgs || []).map(msg => {
          const redirected = msg.redirected_id ? redirectedMap.get(msg.redirected_id) : null;
          return {
            ...msg,
            sender_name: userMap[msg.sender_id],
            sender_nick: nickMap[msg.sender_id],
            read_by: msg.read_by || [],
            redirected_name: redirected && msg.show_names ? userMap[redirected.sender_id] : null,
            redirected_nick: redirected && msg.show_names ? nickMap[redirected.sender_id] : null,
            redirected_content: redirected ? redirected.content : null,
            redirected_files: redirected ? (redirected.message_files || []).map(f => ({
              url: f.file_url,
              name: f.file_name,
              type: f.file_type
            })) : null,
            redirected_answer: redirected ? redirected.answer_id : null,
            files: msg.message_files
              ? msg.message_files.map(f => ({
                  url: f.file_url,
                  name: f.file_name,
                  type: f.file_type
                }))
              : []
          };
        });
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
          nick: chatWith.nick,
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

app.get("/chat/group/:id", authenticateUser(supabase), async (req, res) => {
  const { id: userId } = req.user;
  const chatId = req.params.id;

  try {
    // Проверка участия в группе
    const { data: member, error: memberError } = await supabase
      .from("chat_members")
      .select("id, note, pinned, is_blocked")
      .eq("chat_id", chatId)
      .eq("user_id", userId)
      .single();

    if (memberError || !member) {
      return res.status(403).json({ success: false, error: "Нет доступа к чату" });
    }

    // Информация о чате
    const { data: chat, error: chatError } = await supabase
      .from("chats")
      .select("id, name, avatar_url")
      .eq("id", chatId)
      .single();

    if (chatError || !chat) {
      return res.status(404).json({ success: false, error: "Чат не найден" });
    }

    // Участники группы
    const { data: memberIds } = await supabase
      .from("chat_members")
      .select("user_id")
      .eq("chat_id", chatId);

    const userIds = memberIds?.map(m => m.user_id) || [];
    const { data: members } = await supabase
      .from("users")
      .select("id, nick, username, avatar_url")
      .in("id", userIds);

    // Сообщения
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
        answer_id,
        edited,
        redirected_id,
        show_names,
        is_system
      `)
      .eq("chat_id", chatId)
      .not('hidden', 'cs', `{"${userId}"}`)
      .order("created_at", { ascending: true });

    let messages = [];

    if (msgs && msgs.length > 0) {
      // Собираем всех отправителей (включая из перенаправленных сообщений)
      const redirectedIds = msgs
        .map(msg => msg.redirected_id)
        .filter(rId => rId !== null);
      const uniqueRedirectedIds = [...new Set(redirectedIds)];

      let redirectedMap = new Map();
      let redirectedSenders = new Set();

      if (uniqueRedirectedIds.length > 0) {
        const { data: redirectedData } = await supabase
          .from("messages")
          .select(`
            id,
            sender_id,
            content,
            answer_id,
            message_files (file_url, file_name, file_type),
            is_system
          `)
          .in("id", uniqueRedirectedIds);

        if (redirectedData) {
          for (const m of redirectedData) {
            if (m.redirected_id) {
              const originalId = await resolveOriginalRedirect(supabase, m.redirected_id);
              const { data: original } = await supabase
                .from("messages")
                .select("content, answer_id, message_files (file_url, file_name, file_type), is_system")
                .eq("id", originalId)
                .single();

              if (original) {
                m.content = original.content;
                m.answer_id = original.answer_id;
                m.message_files = original.message_files;
                m.is_system = original.is_system;
              }
            }
            redirectedMap.set(m.id, m);
            redirectedSenders.add(m.sender_id);
          }
        }
      }

      // Все уникальные sender_id
      const allSenderIds = new Set([
        ...msgs.map(m => m.sender_id),
        ...redirectedSenders,
        userId
      ]);

      const { data: users } = await supabase
        .from("users")
        .select("id, username, nick")
        .in("id", Array.from(allSenderIds));

      const userMap = {};
      const nickMap = {};
      (users || []).forEach(u => {
        userMap[u.id] = u.username || u.nick;
        nickMap[u.id] = u.nick;
      });

      // Форматируем сообщения (точно как в личном чате)
      messages = msgs.map(msg => {
        const redirected = msg.redirected_id ? redirectedMap.get(msg.redirected_id) : null;

        return {
          ...msg,
          sender_name: userMap[msg.sender_id] || null,
          sender_nick: nickMap[msg.sender_id] || null,
          files: msg.message_files
            ? msg.message_files.map(f => ({
                url: f.file_url,
                name: f.file_name,
                type: f.file_type
              }))
            : [],
          redirected_name: redirected && msg.show_names ? userMap[redirected.sender_id] : null,
          redirected_nick: redirected && msg.show_names ? nickMap[redirected.sender_id] : null,
          redirected_content: redirected ? redirected.content : null,
          redirected_files: redirected
            ? (redirected.message_files || []).map(f => ({
                url: f.file_url,
                name: f.file_name,
                type: f.file_type
              }))
            : null,
          redirected_answer: redirected ? redirected.answer_id : null,
          is_system: msg.is_system
        };
      });
    }

    // Отметка прочитанных сообщений
    const messagesToUpdate = messages.filter(
      m => m.sender_id !== userId && !m.read_by.includes(userId)
    );

    if (messagesToUpdate.length > 0) {
      for (const m of messagesToUpdate) {
        await supabase
          .from("messages")
          .update({ read_by: [...m.read_by, userId] })
          .eq("id", m.id);

        broadcastMessageRead(chatId, m.id, userId);
      }
    }

    res.json({
      success: true,
      chat: {
        id: chat.id,
        name: chat.name,
        avatar_url: chat.avatar_url,
        is_group: true,
        members: members?.map(m => ({ id: m.id, nick: m.nick, avatar_url:m.avatar_url })) || [],
        note: member.note ?? false,
        is_blocked: member.is_blocked ?? false,
        pinned: member.pinned ?? false,
        am_i_blocked: false,
        last_online: ""
      },
      messages
    });
  } catch (err) {
    console.error("Ошибка в /chat/group/:id:", err);
    res.status(500).json({ success: false, error: "Ошибка сервера" });
  }
});

  // Отправка сообщения (с поддержкой файлов)
  app.post("/chat", authenticateUser(supabase), upload.array("files"), async (req, res) => {
  const { id: senderId } = req.user;
  const { receiver_nick, chat_id: reqChatId, text, answer_id } = req.body;

  let redirect = [];
  let show_names = true;
  if (req.body.redirect) {
    redirect = JSON.parse(req.body.redirect);
    show_names = req.body.showNames === "1";
  }

  const files = req.files || [];

  if ((!text || !text.trim()) && files.length === 0 && redirect.length === 0) {
    return res.status(400).json({ success: false, error: "Сообщение пустое" });
  }

  try {
    let chatId;

    // Определяем тип чата
    if (reqChatId) {
      // Групповой чат
      chatId = reqChatId;
      const { data: member } = await supabase
        .from("chat_members")
        .select("id")
        .eq("chat_id", chatId)
        .eq("user_id", senderId)
        .single();

      if (!member) {
        return res.status(403).json({ success: false, error: "Нет доступа к группе" });
      }
    } else if (receiver_nick) {
      // Приватный чат — старая логика
      const { data: receiverUser, error: receiverError } = await supabase
        .from("users")
        .select("id")
        .eq("nick", receiver_nick)
        .single();

      if (receiverError || !receiverUser) {
        return res.status(404).json({ success: false, error: "Пользователь не найден" });
      }

      const receiver_id = receiverUser.id;

      const { data: myChats } = await supabase
        .from("chat_members")
        .select("chat_id")
        .eq("user_id", senderId);
      const myChatIds = myChats?.map(c => c.chat_id) || [];

      const { data: theirChats } = await supabase
        .from("chat_members")
        .select("chat_id")
        .eq("user_id", receiver_id);
      const theirChatIds = theirChats?.map(c => c.chat_id) || [];

      chatId = myChatIds.find(id => theirChatIds.includes(id));

      if (!chatId) {
        const { data: newChat } = await supabase
          .from("chats")
          .insert({})
          .select("id")
          .single();
        chatId = newChat.id;
        await supabase.from("chat_members").insert([
          { chat_id: chatId, user_id: senderId },
          { chat_id: chatId, user_id: receiver_id },
        ]);
      }

      if (receiver_nick === "ATBot") {
        const bot = BotInit(supabase);
        bot.handleMessage({ chatId, userMessage: text });
      }
    } else {
      return res.status(400).json({ success: false, error: "Не указан получатель или группа" });
    }

    // Resolve redirect'ов
    const resolvedRedirects = [];
    if (redirect.length > 0) {
      for (const rid of redirect) {
        const originalId = await resolveOriginalRedirect(supabase, rid);
        resolvedRedirects.push(originalId);
      }
    }

    // Основное сообщение
    const { data: mainMessage } = await supabase
      .from("messages")
      .insert([{
        chat_id: chatId,
        sender_id: senderId,
        content: text || "",
        answer_id: answer_id || null,
        redirected_id: resolvedRedirects.length > 0 ? resolvedRedirects[0] : null,
        show_names: redirect.length ? show_names : true
      }])
      .select()
      .single();

    const createdMessages = [mainMessage];

    // Дополнительные redirect-сообщения (без контента и файлов)
    if (resolvedRedirects.length > 1) {
      for (let i = 1; i < resolvedRedirects.length; i++) {
        const { data: redirectMsg } = await supabase
          .from("messages")
          .insert([{
            chat_id: chatId,
            sender_id: senderId,
            content: "",
            redirected_id: resolvedRedirects[i],
            show_names: show_names
          }])
          .select()
          .single();
        createdMessages.push(redirectMsg);
      }
    }

    // Загрузка файлов (только к основному сообщению)
    let filesData = [];
    if (files.length > 0) {
      for (const file of files) {
        const ext = path.extname(file.originalname);
        const uniqueName = crypto.randomUUID() + ext;
        const filePath = `${senderId}/${uniqueName}`;
        const { error: uploadError } = await supabase.storage
          .from("media")
          .upload(filePath, file.buffer, { contentType: file.mimetype });
        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
          .from("media")
          .getPublicUrl(filePath);

        filesData.push({
          message_id: mainMessage.id,
          file_url: publicUrl,
          file_name: file.originalname,
          file_type: file.mimetype.substring(0, 50),
          file_size: file.size
        });
      }
      const { error: insertError } = await supabase.from("message_files").insert(filesData);
      if (insertError) throw insertError;
    }

    // Инфо отправителя
    const { data: senderInfo } = await supabase
      .from("users")
      .select("username, nick")
      .eq("id", senderId)
      .single();

    // Формируем ответ и бродкаст
    const finalResponseMessages = [];

    for (const msg of createdMessages) {
      const currentMsgFiles = msg.id === mainMessage.id
        ? filesData.map(f => ({ url: f.file_url, name: f.file_name, type: f.file_type }))
        : [];

      let redirectedFullInfo = {};
      if (msg.redirected_id) {
        const { data: originalMsg } = await supabase
          .from("messages")
          .select("content, sender_id, answer_id, message_files (file_url, file_name, file_type)")
          .eq("id", msg.redirected_id)
          .single();

        if (originalMsg) {
          let originalUser = null;
          if (msg.show_names) {
            const { data: ou } = await supabase
              .from("users")
              .select("username, nick")
              .eq("id", originalMsg.sender_id)
              .single();
            originalUser = ou;
          }
          redirectedFullInfo = {
            redirected_name: originalUser ? (originalUser.username || originalUser.nick) : null,
            redirected_nick: originalUser ? originalUser.nick : null,
            redirected_content: originalMsg.content,
            redirected_answer: originalMsg.answer_id,
            redirected_files: originalMsg.message_files?.map(f => ({
              url: f.file_url, name: f.file_name, type: f.file_type
            })) || []
          };
        }
      }

      const completeMessage = {
        ...msg,
        sender_name: senderInfo ? (senderInfo.username || senderInfo.nick) : null,
        sender_nick: senderInfo ? senderInfo.nick : null,
        read_by: msg.read_by || [],
        reactions: [],
        files: currentMsgFiles,
        ...redirectedFullInfo,
        is_system: false
      };

      // Бродкаст (в ws.js добавьте is_group если нужно)
      broadcastNewMessage(chatId, completeMessage);

      finalResponseMessages.push(completeMessage);
    }

    res.json({ success: true, messages: finalResponseMessages });
  } catch (err) {
    console.error("Ошибка при отправке сообщения:", err);
    res.status(500).json({ success: false, error: "Ошибка сервера" });
  }
});
  // Редактирование сообщения (новый маршрут)
  app.patch("/messages/:id", authenticateUser(supabase), upload.array("files"), async (req, res) => {
    const { id: userId } = req.user;
    const messageId = parseInt(req.params.id);
    const { text, answer_id, kept_urls } = req.body;
    const newFiles = req.files || [];
    const keptUrls = kept_urls ? JSON.parse(kept_urls) : [];
    if ((!text || !text.trim()) && newFiles.length === 0 && keptUrls.length === 0) {
      return res.status(400).json({ success: false, error: "Сообщение пустое" });
    }
    try {
      // Получаем сообщение
      const { data: message, error: msgError } = await supabase
        .from("messages")
        .select("*, chat_id")
        .eq("id", messageId)
        .single();
      if (msgError || !message) {
        return res.status(404).json({ success: false, error: "Сообщение не найдено" });
      }
      if (message.sender_id !== userId) {
        return res.status(403).json({ success: false, error: "Вы не автор сообщения" });
      }
      // Обновляем текст и флаг edited
      const updates = { edited: true };
      if (text !== undefined) updates.content = text;
      if (answer_id) updates.answer_id = answer_id;
      await supabase.from("messages").update(updates).eq("id", messageId);
      // Обработка файлов: удаляем не сохраненные
      if (keptUrls.length > 0) {
        await supabase
          .from("message_files")
          .delete()
          .eq("message_id", messageId)
          .not("file_url", "in", `(${keptUrls.join(",")})`);
      } else {
        await supabase.from("message_files").delete().eq("message_id", messageId);
      }
      // Добавляем новые файлы
      let newFilesData = [];
      if (newFiles.length > 0) {
        for (const file of newFiles) {
          const ext = path.extname(file.originalname);
          const uniqueName = crypto.randomUUID() + ext;
          const filePath = `${userId}/${uniqueName}`;
          const { error: uploadError } = await supabase.storage
            .from("media")
            .upload(filePath, file.buffer, { contentType: file.mimetype });
          if (uploadError) throw uploadError;
          const { data: { publicUrl } } = supabase.storage.from("media").getPublicUrl(filePath);
          newFilesData.push({
            message_id: messageId,
            file_url: publicUrl,
            file_name: file.originalname,
            file_type: file.mimetype.substring(0, 50),
            file_size: file.size
          });
        }
        const { error: insertError } = await supabase.from("message_files").insert(newFilesData);
        if (insertError) throw insertError;
      }
      // Получаем обновленные файлы
      const { data: updatedFiles } = await supabase
        .from("message_files")
        .select("file_url, file_name, file_type")
        .eq("message_id", messageId);
      const messageWithFiles = {
        ...message,
        content: text || message.content,
        files: updatedFiles.map(f => ({ url: f.file_url, name: f.file_name, type: f.file_type })),
        edited: true
      };
      // Бродкаст через WS
      broadcastMessageEdited(message.chat_id, messageWithFiles);
      res.json({ success: true, message: messageWithFiles });
    } catch (err) {
      console.error("Ошибка при редактировании сообщения:", err);
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