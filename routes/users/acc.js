import { visiblePosts, signedRows } from "../../utils/postContent.js";
import { authenticateUser } from "../../middleware/token.js";
import { isUserOnline } from "../../realtime/ws.js";
import { relationship,ownerPrivacy,permitted,defaults } from "../../utils/privacy.js";

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
      const privacy = await ownerPrivacy(supabase, acc.id);
      const rules = { ...defaults,...privacy.rules };
      const rel = await relationship(supabase,req.user?.id,acc.id);
      const canSee = (field,token = privacy.token,override = null) =>
        permitted({ rules,field,ownerId:acc.id,viewerId:req.user?.id,contact:rel.contact,
          blocked:rel.blocked,share:req.query?.share,token,override });
      const canSeeProfile = canSee("profile");
      const privateRules = {
        number:"nobody",mail:"nobody",
        profile:canSeeProfile ? "all" : "nobody",
        habits:canSee("habits") ? "all" : "nobody",
        posts:canSee("posts") ? "all" : "nobody",
        plans:canSee("plans") ? "all" : "nobody"
      };
      const isContact = rel.contact || req.user?.id === acc.id;

      const presenceRule = rules.presence || "all";
      const canShowPresence = (req.user?.id === acc.id || presenceRule === "all"
        || (presenceRule === "contacts" && isContact))
        && await canViewProfilePresence(supabase, req.user?.id, acc.id);
      const publicAcc = {
        ...acc,
        bio:canSeeProfile ? acc.bio : null,
        date_of_birth:canSeeProfile ? acc.date_of_birth : null,
        sex:canSeeProfile ? acc.sex : null,
        registration_date:canSeeProfile ? acc.registration_date : null,
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
      if (canSee("habits")) {
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

      const { data:ownerPlans,error:planError } = await supabase.from("one_off_plans")
        .select("*").eq("owner_id",acc.id).order("plan_date",{ ascending:true }).limit(200);
      if (planError) throw planError;
      const plans = (ownerPlans || []).filter(plan => canSee("plans",plan.share_token,plan.visibility))
        .map(plan => ({ id:plan.id,name:plan.name,plan_date:plan.plan_date,start_time:plan.start_time,
          end_time:plan.end_time,tag:plan.tag,kind:plan.kind,status:plan.status,
          visibility:plan.visibility,membership_status:"viewer",
          share:plan.visibility === "link" || plan.visibility === "inherit" && rules.plans === "link"
            ? req.query?.share : null }));
      return res.json({
        success: true,
        acc: publicAcc,
        habits: habits || [],
        plans,
        privateRules,
        posts: await signedRows(supabase, await visiblePosts(supabase, posts || [], req.user?.id, req.query?.share), "media", "posts"),
      });
    } catch (err) {
      console.error("Ошибка при получении аккаунта:", err);
      return res.status(500).json({ success: false, error: "Server error" });
    }
  });
}