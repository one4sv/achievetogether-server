import { authenticateUser } from "./middleware/token.js";
import resolveOriginalRedirect from "./funcs/resolveRedirect.js";

export default function (app, supabase) {
  app.post("/contacts", authenticateUser(supabase), async (req, res) => {
    const { id: currentUserId } = req.user;
    const { search } = req.body;

    try {
      // 1. Все чаты пользователя
      const { data: chat_members } = await supabase
        .from("chat_members")
        .select("chat_id")
        .eq("user_id", currentUserId);

      const chatIds = Array.isArray(chat_members)
        ? chat_members.map(c => c.chat_id)
        : [];

      if (chatIds.length === 0) {
        return res.json({ success: true, friendsArr: [] });
      }

      // 2. Детали чатов
      const { data: chats } = await supabase
        .from("chats")
        .select("id, name, avatar_url, is_group")
        .in("id", chatIds);

      const safeChats = Array.isArray(chats) ? chats : [];

      const privateChats = safeChats.filter(c => !c.is_group);
      const groupChats = safeChats.filter(c => c.is_group);

      const privateChatIds = privateChats.map(c => c.id);
      const groupChatIds = groupChats.map(c => c.id);

      // 3. Настройки пользователя для чатов
      const { data: userChatSettings } = await supabase
        .from("chat_members")
        .select("chat_id, note, pinned, is_blocked")
        .eq("user_id", currentUserId)
        .in("chat_id", chatIds);

      const settingsMap = {};
      (userChatSettings || []).forEach(s => {
        settingsMap[s.chat_id] = s;
      });

      // 4. Приватные контакты
      let privateContacts = [];
      let safeOtherUsers = []; // ← Инициализируем здесь, чтобы была доступна всегда

      if (privateChatIds.length > 0) {
        const { data: otherUsers } = await supabase
          .from("chat_members")
          .select("chat_id, user_id")
          .in("chat_id", privateChatIds)
          .neq("user_id", currentUserId);

        safeOtherUsers = Array.isArray(otherUsers) ? otherUsers : [];

        const uniqueUserIds = [...new Set(safeOtherUsers.map(u => u.user_id))];

        if (uniqueUserIds.length > 0) {
          const { data: users } = await supabase
            .from("users")
            .select("id, username, nick, avatar_url")
            .in("id", uniqueUserIds);

          privateContacts = (Array.isArray(users) ? users : []).map(user => {
            const chatEntry = safeOtherUsers.find(cu => cu.user_id === user.id);
            const settings = settingsMap[chatEntry?.chat_id] || {};
            return {
              id: user.id,
              name: user.username || null,
              nick: user.nick,
              avatar_url: user.avatar_url || null,
              is_group: false,
              note: settings.note ?? false,
              pinned: settings.pinned ?? false,
              is_blocked: settings.is_blocked ?? false,
            };
          });
        }
      }

      // 5. Групповые контакты
      const groupContacts = groupChats.map(group => {
        const settings = settingsMap[group.id] || {};
        return {
          id: group.id.toString(),
          name: group.name || null,
          nick: `group_${group.id}`,
          avatar_url: group.avatar_url || null,
          is_group: true,
          note: settings.note ?? false,
          pinned: settings.pinned ?? false,
          is_blocked: settings.is_blocked ?? false,
        };
      });

      // 6. Последние сообщения со всеми полями
      const { data: rawMessages } = await supabase
        .from("messages")
        .select(`
          id,
          chat_id,
          sender_id,
          content,
          created_at,
          read_by,
          reactions,
          answer_id,
          edited,
          redirected_id,
          show_names,
          is_system
        `)
        .in("chat_id", chatIds)
        .not('hidden', 'cs', `{"${currentUserId}"}`)
        .order("created_at", { ascending: false });

      const safeMessages = Array.isArray(rawMessages) ? rawMessages : [];

      // Файлы
      const messageIds = safeMessages.map(m => m.id);
      const { data: files } = await supabase
        .from("message_files")
        .select("message_id, file_url, file_name, file_type")
        .in("message_id", messageIds);

      const safeFiles = Array.isArray(files) ? files : [];

      const messagesWithFiles = safeMessages.map(msg => ({
        ...msg,
        files: safeFiles
          .filter(f => f.message_id === msg.id)
          .map(f => ({
            url: f.file_url,
            name: f.file_name,
            type: f.file_type,
          })),
      }));

      // Последнее сообщение по чату
      const lastMessagesByChat = {};
      messagesWithFiles.forEach(msg => {
        if (!lastMessagesByChat[msg.chat_id]) {
          lastMessagesByChat[msg.chat_id] = msg;
        }
      });

      // 7. Обработка redirected для lastMessage
      const lastMsgs = Object.values(lastMessagesByChat);
      const redirectedIds = lastMsgs
        .map(m => m.redirected_id)
        .filter(Boolean);
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

      // Имена отправителей
      const allSenderIds = new Set([
        ...lastMsgs.map(m => m.sender_id),
        ...Array.from(redirectedSenders),
        currentUserId,
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

      // Форматируем lastMessage
      const formattedLastMessagesByChat = {};
      Object.entries(lastMessagesByChat).forEach(([chatId, msg]) => {
        const redirected = msg.redirected_id ? redirectedMap.get(msg.redirected_id) : null;

        formattedLastMessagesByChat[chatId] = {
          ...msg,
          sender_name: userMap[msg.sender_id] || null,
          sender_nick: nickMap[msg.sender_id] || null,
          redirected_name: redirected && msg.show_names ? userMap[redirected?.sender_id] : null,
          redirected_nick: redirected && msg.show_names ? nickMap[redirected?.sender_id] : null,
          redirected_content: redirected ? redirected.content : null,
          redirected_files: redirected
            ? (redirected.message_files || []).map(f => ({
                url: f.file_url,
                name: f.file_name,
                type: f.file_type,
              }))
            : null,
          redirected_answer: redirected ? redirected.answer_id : null,
          reactions: msg.reactions || [],
          edited: msg.edited || false,
        };
      });

      // 8. unread_count
      const unreadByChat = {};
      messagesWithFiles.forEach(msg => {
        if (msg.sender_id !== currentUserId && !msg.read_by.includes(currentUserId)) {
          unreadByChat[msg.chat_id] = (unreadByChat[msg.chat_id] || 0) + 1;
        }
      });

      // 9. Добавляем lastMessage и unread_count
      const addInfo = (contact, chatId) => ({
        ...contact,
        lastMessage: formattedLastMessagesByChat[chatId] || null,
        unread_count: unreadByChat[chatId] || 0,
      });

      const fullPrivate = privateContacts.map(contact => {
        const chatEntry = safeOtherUsers.find(cu => cu.user_id === contact.id);
        const chatId = chatEntry?.chat_id;
        return addInfo(contact, chatId);
      });

      const fullGroups = groupContacts.map(contact =>
        addInfo(contact, parseInt(contact.id))
      );

      // 10. Поиск
      let result = [...fullPrivate, ...fullGroups];

      if (search && search.trim()) {
        const lower = search.toLowerCase();

        const filteredPrivate = fullPrivate.filter(
          c =>
            (c.name && c.name.toLowerCase().includes(lower)) ||
            (c.nick && c.nick.toLowerCase().includes(lower))
        );

        const filteredGroups = fullGroups.filter(
          c => c.name && c.name.toLowerCase().includes(lower)
        );

        // Новые пользователи по поиску
        const { data: searchUsersData } = await supabase
          .from("users")
          .select("id, username, nick, avatar_url")
          .or(`username.ilike.%${search}%,nick.ilike.%${search}%`)
          .neq("id", currentUserId);

        const existingIds = new Set(fullPrivate.map(c => c.id));
        const newUsers = (Array.isArray(searchUsersData) ? searchUsersData : [])
          .filter(u => !existingIds.has(u.id))
          .map(u => ({
            id: u.id,
            name: u.username || null,
            nick: u.nick,
            avatar_url: u.avatar_url || null,
            lastMessage: null,
            unread_count: 0,
            note: true,
            pinned: false,
            is_blocked: false,
            is_group: false,
          }));

        result = [...filteredPrivate, ...filteredGroups, ...newUsers];
      }

      res.json({ success: true, friendsArr: result });
    } catch (err) {
      console.error("Failed in /contacts:", err);
      res.status(500).json({ success: false, error: "Server error" });
    }
  });
}