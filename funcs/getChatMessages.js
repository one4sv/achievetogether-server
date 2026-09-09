import resolveOriginalRedirect from "../funcs/resolveRedirect.js";

/**
 * Универсальная функция загрузки сообщений чата с пагинацией
 * @param {object} supabase
 * @param {string} chatId
 * @param {string} userId - текущий пользователь
 * @param {object} options
 * @param {number} [options.limit=50]
 * @param {number|null} [options.beforeId]
 * @param {number|null} [options.aroundId]
 */
export async function getChatMessages(supabase, chatId, userId, options = {}) {
  const limit = Math.min(parseInt(options.limit) || 50, 100);
  const beforeId = options.beforeId ? parseInt(options.beforeId) : null;
  const aroundId = options.aroundId ? parseInt(options.aroundId) : null;

  let msgs = [];

  // ========== AROUND (переход к сообщению) ==========
  if (aroundId) {
    const { data: target } = await supabase
      .from("messages")
      .select("created_at")
      .eq("id", aroundId)
      .eq("chat_id", chatId)
      .single();

    if (!target) {
      return { messages: [], hasMore: false };
    }

    const half = Math.floor(limit / 2);

    // Более новые сообщения
    const { data: newer } = await supabase
      .from("messages")
      .select(`
        id, sender_id, content, created_at, read_by, reactions,
        message_files (file_url, file_name, file_type),
        answer_id, edited, redirected_id, show_names, is_system, is_pinned, target_id
      `)
      .eq("chat_id", chatId)
      .not("hidden", "cs", `{"${userId}"}`)
      .gt("created_at", target.created_at)
      .order("created_at", { ascending: true })
      .limit(half);

    // Более старые + само сообщение
    const { data: older } = await supabase
      .from("messages")
      .select(`
        id, sender_id, content, created_at, read_by, reactions,
        message_files (file_url, file_name, file_type),
        answer_id, edited, redirected_id, show_names, is_system, is_pinned, target_id
      `)
      .eq("chat_id", chatId)
      .not("hidden", "cs", `{"${userId}"}`)
      .lte("created_at", target.created_at)
      .order("created_at", { ascending: false })
      .limit(half + 1);

    msgs = [...(older || []).reverse(), ...(newer || [])];
  }

  // ========== BEFORE (подгрузка старых) ==========
  else if (beforeId) {
    const { data: beforeMsg } = await supabase
      .from("messages")
      .select("created_at")
      .eq("id", beforeId)
      .eq("chat_id", chatId)
      .single();

    if (!beforeMsg) {
      return { messages: [], hasMore: false };
    }

    const { data } = await supabase
      .from("messages")
      .select(`
        id, sender_id, content, created_at, read_by, reactions,
        message_files (file_url, file_name, file_type),
        answer_id, edited, redirected_id, show_names, is_system, is_pinned, target_id
      `)
      .eq("chat_id", chatId)
      .not("hidden", "cs", `{"${userId}"}`)
      .lt("created_at", beforeMsg.created_at)
      .order("created_at", { ascending: false })
      .limit(limit);

    msgs = (data || []).reverse();
  }

  // ========== ПЕРВАЯ ЗАГРУЗКА (последние сообщения) ==========
  else {
    const { data } = await supabase
      .from("messages")
      .select(`
        id, sender_id, content, created_at, read_by, reactions,
        message_files (file_url, file_name, file_type),
        answer_id, edited, redirected_id, show_names, is_system, is_pinned, target_id
      `)
      .eq("chat_id", chatId)
      .not("hidden", "cs", `{"${userId}"}`)
      .order("created_at", { ascending: false })
      .limit(limit);

    msgs = (data || []).reverse();
  }

  if (!msgs.length) {
    return { messages: [], hasMore: false };
  }

  // ========== Redirected сообщения ==========
  const redirectedIds = msgs
    .map((msg) => msg.redirected_id)
    .filter((rId) => rId !== null);

  const uniqueRedirectedIds = [...new Set(redirectedIds)];
  let redirectedMap = new Map();
  let redirectedMsgs = [];

  if (uniqueRedirectedIds.length > 0) {
    const { data: redirectedData } = await supabase
      .from("messages")
      .select(`
        id, sender_id, content, created_at,
        message_files (file_url, file_name, file_type),
        answer_id, edited, is_system, is_pinned, redirected_id
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
      }
      redirectedMsgs = redirectedData;
    }
  }

  // ========== Пользователи ==========
  const allSenderIds = new Set();
  msgs.forEach((msg) => allSenderIds.add(msg.sender_id));
  redirectedMsgs.forEach((m) => allSenderIds.add(m.sender_id));
  allSenderIds.add(userId);

  const { data: users } = await supabase
    .from("users")
    .select("id, username, nick")
    .in("id", Array.from(allSenderIds));

  const userMap = {};
  const nickMap = {};
  (users || []).forEach((u) => {
    userMap[u.id] = u.username || u.nick;
    nickMap[u.id] = u.nick;
  });

  // ========== Финальная сборка ==========
  const messages = msgs.map((msg) => {
    const redirected = msg.redirected_id ? redirectedMap.get(msg.redirected_id) : null;

    return {
      ...msg,
      sender_name: userMap[msg.sender_id] || null,
      sender_nick: nickMap[msg.sender_id] || null,
      read_by: msg.read_by || [],
      files: msg.message_files
        ? msg.message_files.map((f) => ({
            url: f.file_url,
            name: f.file_name,
            type: f.file_type,
          }))
        : [],
      redirected_name: redirected && msg.show_names ? userMap[redirected.sender_id] : null,
      redirected_nick: redirected && msg.show_names ? nickMap[redirected.sender_id] : null,
      redirected_content: redirected ? redirected.content : null,
      redirected_files: redirected
        ? (redirected.message_files || []).map((f) => ({
            url: f.file_url,
            name: f.file_name,
            type: f.file_type,
          }))
        : null,
      redirected_answer: redirected ? redirected.answer_id : null,
    };
  });

  const hasMore = msgs.length === limit;

  return { messages, hasMore };
}