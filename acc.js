import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
  app.get("/acc/:nick", authenticateUser(supabase), async (req, res) => {
    try {
      const { nick } = req.params;
      const { id: user_id } = req.user;

      // --- 1. Получаем данные пользователя
      const { data: acc, error: accError } = await supabase
        .from("users")
        .select("*")
        .eq("nick", nick)
        .maybeSingle();
      
      if (!acc) {
        return res.status(404).json({ success: false, error: "User not found" });
      }
      if (accError) throw accError;

      // --- 2. Получаем привычки
      const { data: habits, error: habitsError } = await supabase
        .from("habits")
        .select("*")
        .eq("user_id", acc.id);
      if (habitsError) throw habitsError;

      // --- 3. Приватные настройки
      const { data: settings, error: privateError } = await supabase
        .from("settings")
        .select("private")
        .eq("user_id", acc.id)
        .single();
      if (privateError) throw privateError;

      // --- 4. Посты
      const { data: posts, error: postsError } = await supabase
        .from("posts")
        .select("*")
        .eq("user_id", acc.id)
        .order("created_at", { ascending: false });
      if (postsError) throw postsError;

      // --- 5. Получаем ID чатов, где есть оба пользователя
      const { data: userChats } = await supabase
        .from("chat_members")
        .select("chat_id")
        .eq("user_id", user_id);

      const { data: accChats } = await supabase
        .from("chat_members")
        .select("chat_id")
        .eq("user_id", acc.id);

      const commonChatIds = userChats
        ?.map(c => c.chat_id)
        .filter(c => accChats?.some(a => a.chat_id === c)) || [];

      let media = [];
      if (commonChatIds.length > 0) {
        // 1️⃣ Получаем все id сообщений из общих чатов
        const { data: messages, error: msgError } = await supabase
          .from("messages")
          .select("id")
          .in("chat_id", commonChatIds);

        if (msgError) throw msgError;

        const messageIds = messages?.map(m => m.id) || [];

        if (messageIds.length > 0) {
          const { data: files, error: filesError } = await supabase
            .from("message_files")
            .select("id, file_url, file_type, file_name")
            .in("message_id", messageIds)
            .order("created_at", { ascending: false });

          if (filesError) throw filesError;

          media = files?.map(f => ({
            url: f.file_url,
            name: f.file_name,
            type: f.file_type
          })) || [];
        }
      }

      return res.json({
        success: true,
        acc,
        habits,
        privateRules: settings?.private || {},
        posts: posts || [],
        media,
      });
    } catch (err) {
      console.error("Ошибка при получении аккаунта:", err);
      return res.status(500).json({ success: false, error: "Server error" });
    }
  });
}
