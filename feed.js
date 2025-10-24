import multer from "multer";
import { authenticateUser } from "./middleware/token.js";

const upload = multer({ storage: multer.memoryStorage() });

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

      // 3) формируем список авторов, чьи посты хотим видеть: контакты + сам пользователь
      // Если нужны только контакты — убери userId из массива
      const authorIds = [...new Set([ ...contactUserIds])];

      // если нет авторов — вернём пустой массив
      if (authorIds.length === 0) {
        return res.json({ success: true, posts: [] });
      }

      // 4) получаем посты этих авторов (последние сверху), можно ограничить (limit) по желанию
      const { data: postsData, error: postsErr } = await supabase
        .from("posts")
        .select("*")
        .in("user_id", authorIds)
        .order("created_at", { ascending: false })
        .limit(100); // при желании менять/удалить

      if (postsErr) throw postsErr;

      const safePosts = Array.isArray(postsData) ? postsData : [];

      // 5) собираем user_ids из найденных постов и подтягиваем инфо о пользователях
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

      // 6) нормализуем посты: добавляем user объект, парсим media (если нужно), берём comments_count из поля
      const posts = safePosts.map(p => {
        const user = safeUsers.find(u => u.id === p.user_id) || {
          id: p.user_id,
          nick: null,
          username: null,
          avatar_url: null
        };

        // media может быть jsonb (объект) или строкой — нормализуем в массив
        let media = [];
        if (p.media) {
          if (typeof p.media === "string") {
            try {
              media = JSON.parse(p.media);
            } catch (e) {
              media = [];
            }
          } else {
            media = p.media;
          }
        }

        // Берём comments_count прямо из поля posts.comments_count (если поле есть)
        const comments_count = (typeof p.comments_count !== "undefined") ? p.comments_count : 0;

        return {
          id: p.id,
          user, // содержит id, nick, username, avatar_url
          media,
          habit_id: p.habit_id ?? null,
          text: p.text ?? "",
          likes: p.likes ?? [],
          created_at: p.created_at,
          comments_count,
        };
      });

      return res.json({ success: true, posts });
    } catch (err) {
      console.error("Ошибка при формировании фида:", err);
      return res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}
