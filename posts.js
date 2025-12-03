// routes/postsAndFeed.js
import multer from "multer";
import { authenticateUser } from "./middleware/token.js";

const upload = multer({ storage: multer.memoryStorage() });

function safeParseJSON(value, fallback = []) {
  if (!value) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (e) {
      return fallback;
    }
  }
  return value;
}

export default function (app, supabase) {
  app.get("/feed", authenticateUser(supabase), upload.none(), async (req, res) => {
    const { id:userId } = req.user;
    if (!userId) return res.status(401).json({ success: false });

    try {
      // --- 1) мои чаты
      const { data: myMembers } = await supabase
        .from("chat_members")
        .select("chat_id, is_blocked")
        .eq("user_id", userId);

      const myChatIds = myMembers?.map(m => m.chat_id) || [];

      if (myChatIds.length === 0)
        return res.json({ success: true, posts: [] });

      // --- 2) участники этих чатов (кроме меня)
      const { data: otherMembers } = await supabase
        .from("chat_members")
        .select("user_id, chat_id, is_blocked")
        .in("chat_id", myChatIds)
        .neq("user_id", userId);

      const safeOther = otherMembers || [];

      // --- 3) кого Я заблокировал
      const myBlockedChats = myMembers
        .filter(m => m.is_blocked)
        .map(m => m.chat_id);

      const blockedByMe = safeOther
        .filter(m => myBlockedChats.includes(m.chat_id))
        .map(m => m.user_id);

      // --- 4) кто заблокировал МЕНЯ
      const blockedMe = safeOther
        .filter(m => m.is_blocked)
        .map(m => m.user_id);

      // --- 5) все контакты
      const allContacts = [...new Set(safeOther.map(m => m.user_id))];

      // --- 6) фильтр: убрать кого я заблочил + кто заблочил меня
      const finalAuthors = allContacts.filter(
        uid => !blockedByMe.includes(uid) && !blockedMe.includes(uid)
      );

      if (finalAuthors.length === 0)
        return res.json({ success: true, posts: [] });

      // --- 7) посты
      const { data: postsData } = await supabase
        .from("posts")
        .select("*")
        .in("user_id", finalAuthors)
        .order("created_at", { ascending: false })
        .limit(100);

      const safePosts = postsData || [];

      // --- 8) пользователи
      const postUserIds = [...new Set(safePosts.map(p => p.user_id))];

      let safeUsers = [];
      if (postUserIds.length > 0) {
        const { data: usersData } = await supabase
          .from("users")
          .select("id, nick, username, avatar_url")
          .in("id", postUserIds);

        safeUsers = usersData || [];
      }

      // --- 9) привычки
      const habitIds = [...new Set(safePosts.map(p => p.habit_id).filter(Boolean))];

      let habitById = {};
      if (habitIds.length > 0) {
        const { data: habitsData } = await supabase
          .from("habits")
          .select("*")
          .in("id", habitIds);

        habitById = (habitsData || []).reduce((acc, h) => {
          acc[h.id] = h;
          return acc;
        }, {});
      }

      // --- 10) выполненные привычки
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" });
      let doneSet = new Set();

      if (habitIds.length > 0) {
        const { data: comps } = await supabase
          .from("habit_completions")
          .select("habit_id")
          .in("habit_id", habitIds)
          .eq("user_id", userId)
          .eq("completed_at", today);

        (comps || []).forEach(c => doneSet.add(String(c.habit_id)));
      }

      // --- 11) финальная сборка постов
      const posts = safePosts.map(p => {
        const user = safeUsers.find(u => u.id === p.user_id) || {
          id: p.user_id,
          nick: null,
          username: null,
          avatar_url: null
        };

        const media = safeParseJSON(p.media, []);
        const likes = safeParseJSON(p.likes, []);

        const habit = p.habit_id ? (habitById[p.habit_id] || null) : null;
        if (habit) habit.done = doneSet.has(String(habit.id));

        return {
          id: p.id,
          user,
          media,
          habit,
          text: p.text ?? "",
          likes,
          created_at: p.created_at,
          comments_count: p.comments_count ?? 0,
        };
      });

      return res.json({ success: true, posts });

    } catch (err) {
      console.error("feed error:", err);
      return res.status(500).json({ success: false });
    }
  });

  app.get("/posts/:nick", upload.none(), async (req, res) => {
    try {
      const { nick } = req.params; // user id

      const { data: acc, error: accError } = await supabase
        .from("users")
        .select("id")
        .eq("nick", nick)
        .maybeSingle();

      if (accError) throw accError;
      if (!acc) {
        return res.status(404).json({ success: false, error: "Пользователь не найден" });
      }

      const { data: postsData, error: postsErr } = await supabase
        .from("posts")
        .select("*")
        .eq("user_id", acc.id)
        .order("created_at", { ascending: false });

      if (postsErr) throw postsErr;
      const safePosts = Array.isArray(postsData) ? postsData : [];

      // подгружаем автора (можно взять один раз — все посты одного user_id)
      let author = null;
      if (acc?.id) {
        const { data: userData, error: userErr } = await supabase
          .from("users")
          .select("id, nick, username, avatar_url")
          .eq("id", acc.id)
          .maybeSingle();

        if (userErr) console.warn("Warning: can't fetch author info", userErr);
        author = userData || { id:acc.id, nick: null, username: null, avatar_url: null };
      }

      // подгружаем привычки для постов (если есть)
      const habitIds = [...new Set(safePosts.map(p => p.habit_id).filter(Boolean))];
      let habitById = {};
      if (habitIds.length > 0) {
        const { data: habitsData, error: habitsErr } = await supabase
          .from("habits")
          .select("*")
          .in("id", habitIds);

        if (habitsErr) throw habitsErr;
        const safeHabits = Array.isArray(habitsData) ? habitsData : [];
        habitById = safeHabits.reduce((acc, h) => {
          acc[String(h.id)] = h;
          return acc;
        }, {});
      }

      const posts = safePosts.map(p => {
        const media = safeParseJSON(p.media, []);
        const likes = safeParseJSON(p.likes, []);

        const habit = p.habit_id ? (habitById[String(p.habit_id)] || null) : null;

        return {
          id: p.id,
          user: author,
          media,
          habit,
          text: p.text ?? "",
          likes,
          created_at: p.created_at,
          comments_count: typeof p.comments_count !== "undefined" ? p.comments_count : 0,
        };
      });

      return res.json({ success: true, posts });
    } catch (e) {
      console.error("Ошибка при получении постов:", e);
      return res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}
