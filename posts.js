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
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });

    try {
      // 1) получаем chat_id, где участвует текущий пользователь
      const { data: myChatMembers, error: cmErr } = await supabase
        .from("chat_members")
        .select("chat_id")
        .eq("user_id", userId);

      if (cmErr) throw cmErr;

      const chatIds = Array.isArray(myChatMembers) ? myChatMembers.map(c => c.chat_id) : [];

      // 2) получаем других участников этих чатов (кроме текущего пользователя)
      let contactUserIds = [];
      if (chatIds.length > 0) {
        const { data: otherMembers, error: omErr } = await supabase
          .from("chat_members")
          .select("user_id, chat_id")
          .in("chat_id", chatIds)
          .neq("user_id", userId);

        if (omErr) throw omErr;

        const safeOther = Array.isArray(otherMembers) ? otherMembers : [];
        contactUserIds = [...new Set(safeOther.map(m => m.user_id))];
      }

      // 4) получаем посты этих авторов (последние сверху)
      const { data: postsData, error: postsErr } = await supabase
        .from("posts")
        .select("*")
        .in("user_id", contactUserIds)
        .order("created_at", { ascending: false })
        .limit(100);

      if (postsErr) throw postsErr;
      const safePosts = Array.isArray(postsData) ? postsData : [];

      // 5) подгружаем информацию о пользователях (авторах постов)
      const postUserIds = [...new Set(safePosts.map(p => p.user_id).filter(Boolean))];
      let safeUsers = [];
      if (postUserIds.length > 0) {
        const { data: usersData, error: usersErr } = await supabase
          .from("users")
          .select("id, nick, username, avatar_url")
          .in("id", postUserIds);

        if (usersErr) throw usersErr;
        safeUsers = Array.isArray(usersData) ? usersData : [];
      }

      // 6) подгружаем привычки, если есть habit_id в постах
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

      // 7) проверяем, какие из этих привычек пользователь выполнил сегодня — чтобы пометить .done
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" }); // YYYY-MM-DD
      let doneSet = new Set();
      if (habitIds.length > 0) {
        const { data: comps, error: compsErr } = await supabase
          .from("habit_completions")
          .select("habit_id")
          .in("habit_id", habitIds)
          .eq("user_id", userId)
          .eq("completed_at", today);

        if (compsErr) throw compsErr;
        const safeComps = Array.isArray(comps) ? comps : [];
        safeComps.forEach(c => doneSet.add(String(c.habit_id)));
      }

      // 8) финальная нормализация постов
      const posts = safePosts.map(p => {
        const user = safeUsers.find(u => u.id === p.user_id) || {
          id: p.user_id,
          nick: null,
          username: null,
          avatar_url: null
        };

        const media = safeParseJSON(p.media, []);
        const likes = safeParseJSON(p.likes, []);

        const habit = p.habit_id ? (habitById[String(p.habit_id)] || null) : null;
        if (habit) {
          // приводим поля habit к фронтовому виду (по необходимости)
          habit.done = !!doneSet.has(String(habit.id)); // добавляем done — булево
        }

        return {
          id: p.id,
          user,
          media,
          habit,
          text: p.text ?? "",
          likes,
          created_at: p.created_at,
          comments_count: typeof p.comments_count !== "undefined" ? p.comments_count : 0,
        };
      });

      return res.json({ success: true, posts });
    } catch (err) {
      console.error("Ошибка при формировании фида:", err);
      return res.status(500).json({ success: false, error: "Ошибка сервера" });
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
