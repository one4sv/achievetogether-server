import { authenticateUser } from "../../middleware/token.js";

export default function (app, supabase) {
  app.get("/acc/:nick", authenticateUser(supabase), async (req, res) => {
    try {
      const { nick } = req.params;

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

      return res.json({
        success: true,
        acc,
        habits: habits || [],
        privateRules: isPrivate,
        posts: posts || [],
      });
    } catch (err) {
      console.error("Ошибка при получении аккаунта:", err);
      return res.status(500).json({ success: false, error: "Server error" });
    }
  });
}