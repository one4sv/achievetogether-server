import { authenticateUser } from "./middleware/token.js";

export default function (app, supabase) {
  app.post("/like", authenticateUser(supabase), async (req, res) => {
    const { id: user_id } = req.user; // из middleware
    const { id: post_id } = req.body;

    try {
      // 1. Получаем пост
      const { data: postData, error: getError } = await supabase
        .from("posts")
        .select("likes")
        .eq("id", post_id)
        .single();

      if (getError || !postData)
        return res.status(404).json({ success: false, message: "Пост не найден" });

      // 2. Преобразуем likes (jsonb)
      let likes = postData.likes || [];

      // 3. Проверяем, есть ли лайк
      const hasLiked = likes.includes(user_id);

      // 4. Добавляем или убираем
      if (hasLiked) {
        likes = likes.filter((uid) => uid !== user_id);
      } else {
        likes.push(user_id);
      }

      // 5. Обновляем пост
      const { error: updateError } = await supabase
        .from("posts")
        .update({ likes })
        .eq("id", post_id);

      if (updateError) throw updateError;

      return res.json({
        success: true,
        liked: !hasLiked,
        likesCount: likes.length,
      });
    } catch (err) {
      console.error("Ошибка при обновлении лайков:", err);
      return res.status(500).json({ success: false, message: "Ошибка сервера" });
    }
  });
}
