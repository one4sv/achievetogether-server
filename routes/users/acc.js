import { visiblePosts, signedRows } from "../../utils/postContent.js";
import { authenticateUser } from "../../middleware/token.js";
import { isUserOnline } from "../../realtime/ws.js";

async function canViewProfilePresence(supabase, viewerId, subjectId) {
  if (!viewerId) return false;
  if (viewerId === subjectId) return true;
  const { data: mine, error: mineError } = await supabase.from("chat_members")
    .select("chat_id,is_blocked,chats!inner(is_group)")
    .eq("user_id", viewerId).eq("chats.is_group", false);
  if (mineError) return false;
  const ids = (mine || []).map(item => item.chat_id);
  if (!ids.length) return true;
  const { data: theirs, error: theirError } = await supabase.from("chat_members")
    .select("chat_id,is_blocked,chats!inner(is_group)")
    .eq("user_id", subjectId).eq("chats.is_group", false).in("chat_id", ids);
  if (theirError) return false;
  const byChat = new Map((mine || []).map(item => [String(item.chat_id), item]));
  return !(theirs || []).some(item => item.is_blocked || byChat.get(String(item.chat_id))?.is_blocked);
}


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

      const presenceRule = rules.presence || "all";
      const canShowPresence = (req.user?.id === acc.id || presenceRule === "all"
        || (presenceRule === "contacts" && isContact))
        && await canViewProfilePresence(supabase, req.user?.id, acc.id);
      const publicAcc = {
        ...acc,
        last_online: canShowPresence ? acc.last_online : null,
        is_online: canShowPresence && isUserOnline(acc.id),
        can_view_presence: canShowPresence
      };

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
        acc: publicAcc,
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