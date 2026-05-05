import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
  app.get("/acc/:nick", authenticateUser(supabase), async (req, res) => {
    try {
      const { nick } = req.params;
      const user_id = req.user?.id || null;

      const { data: acc, error: accError } = await supabase
        .from("users")
        .select("*")
        .eq("nick", nick)
        .maybeSingle();

      if (accError) throw accError;
      if (!acc) {
        return res.status(404).json({ success: false, error: "User not found" });
      }

      const { data: settingsData, error: settingsError } = await supabase
        .from("settings")
        .select("show_archived_in_acc, private")
        .eq("user_id", acc.id)
        .maybeSingle();

      if (settingsError) throw settingsError;

      const showArchived = settingsData?.show_archived_in_acc ?? false;
      const isPrivate = settingsData?.private ?? false;

      let habitsQuery = supabase
        .from("habits")
        .select("*")
        .eq("user_id", acc.id);

      if (!showArchived) {
        habitsQuery = habitsQuery.eq("ongoing", true);
      }

      const { data: habits, error: habitsError } = await habitsQuery;
      if (habitsError) throw habitsError;

      const { data: posts, error: postsError } = await supabase
        .from("posts")
        .select("*")
        .eq("user_id", acc.id)
        .order("created_at", { ascending: false });

      if (postsError) throw postsError;

      let media = [];

      if (user_id) {
        const { data: userChats, error: userChatsError } = await supabase
          .from("chat_members")
          .select("chat_id")
          .eq("user_id", user_id);

        if (userChatsError) throw userChatsError;

        const { data: accChats, error: accChatsError } = await supabase
          .from("chat_members")
          .select("chat_id")
          .eq("user_id", acc.id);

        if (accChatsError) throw accChatsError;

        const commonChatIds =
          userChats
            ?.map(c => c.chat_id)
            .filter(c => accChats?.some(a => a.chat_id === c)) || [];

        if (commonChatIds.length > 0) {
          const { data: messages, error: msgError } = await supabase
            .from("messages")
            .select("id")
            .in("chat_id", commonChatIds);

          if (msgError) throw msgError;

          const messageIds = messages?.map(m => m.id) || [];

          if (messageIds.length > 0) {
            const { data: files, error: filesError } = await supabase
              .from("message_files")
              .select("id, file_url, file_type, file_name, message_id")
              .in("message_id", messageIds)
              .order("created_at", { ascending: false });

            if (filesError) throw filesError;

            media =
              files?.map(f => ({
                url: f.file_url,
                name: f.file_name,
                type: f.file_type,
                message_id: f.message_id,
              })) || [];
          }
        }
      }

      return res.json({
        success: true,
        acc,
        habits: habits || [],
        privateRules: isPrivate,
        posts: posts || [],
        media,
      });
    } catch (err) {
      console.error("Ошибка при получении аккаунта:", err);
      return res.status(500).json({ success: false, error: "Server error" });
    }
  });
}