import { visiblePosts, signedRows } from "../../utils/postContent.js";
import { authenticateUser } from "../../middleware/token.js";

export default function (app, supabase) {
  app.get("/acc/:nick", authenticateUser(supabase), async (req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      const { nick } = req.params;

      const { data: acc, error: accError } = await supabase
        .from("users")
        .select("id, nick, username, bio, avatar_url, last_online, registration_date, date_of_birth, sex")
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
      const privacy = settingsData?.private && typeof settingsData.private === "object"
        ? settingsData.private : {};
      const rules = { number: "nobody", mail: "nobody", habits: "all", posts: "all", ...privacy };
      let isContact = req.user?.id === acc.id;
      if (!isContact && req.user?.id && Object.values(rules).includes("contacts")) {
        isContact = (await visiblePosts(supabase,
          [{ user_id: acc.id, visibility: "contacts" }], req.user.id)).length > 0;
      }
      const privateRules = { ...rules };
      if (!isContact) {
        for (const key of ["number", "mail", "habits", "posts"]) {
          if (privateRules[key] === "contacts") privateRules[key] = "nobody";
        }
      }

      let habitsQuery = supabase
        .from("habits")
        .select("*")
        .eq("user_id", acc.id);

      if (!showArchived) {
        habitsQuery = habitsQuery.eq("ongoing", true);
      }

      let habits = [];
      if (req.user?.id === acc.id || privateRules.habits !== "nobody") {
        const { data, error: habitsError } = await habitsQuery;
        if (habitsError) throw habitsError;
        habits = data || [];
      }

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
        privateRules,
        posts: await signedRows(supabase, await visiblePosts(supabase, posts || [], req.user?.id), "media", "posts"),
      });
    } catch (err) {
      console.error("Ошибка при получении аккаунта:", err);
      return res.status(500).json({ success: false, error: "Server error" });
    }
  });
}