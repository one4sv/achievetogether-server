import { authenticateUser } from "../../middleware/token.js";
import { readablePost, signedRows } from "../../utils/postContent.js";
import multer from "multer";

const upload = multer({ storage: multer.memoryStorage() });

export default function (app, supabase) {
    app.get("/comments/:id", authenticateUser(supabase), upload.none(), async (req, res) => {
        res.set("Cache-Control", "no-store");
        const postId = req.params.id;

        try {
            if (!await readablePost(supabase, postId, req.user?.id)) return res.status(404).json({ success: false });
            // Получаем комментарии с id пользователя
            const { data: commentsData, error: commentsError } = await supabase
                .from("posts_comments")
                .select("*, user_id") // предполагаем, что ты добавишь поле user_id
                .eq("post_id", postId)
                .order("created_at", { ascending: true });

            if (commentsError) {
                console.error(commentsError);
                return res.status(500).json({ success: false, message: "Ошибка при получении комментариев" });
            }

            if (!commentsData || commentsData.length === 0) {
                return res.json({ success: true, comments: [] });
            }

            // Собираем id всех пользователей
            const userIds = [...new Set(commentsData.map(c => c.user_id))];

            // Получаем данные пользователей
            const { data: usersData, error: usersError } = await supabase
                .from("users")
                .select("id, nick, username, avatar_url")
                .in("id", userIds);

            if (usersError) {
                console.error(usersError);
                return res.status(500).json({ success: false, message: "Ошибка при получении пользователей" });
            }

            // Сопоставляем пользователей с комментариями
            const signed = await signedRows(supabase, commentsData, "files", "comments");
            const comments = signed.map(c => ({
                ...c,                user: usersData.find(u => u.id === c.user_id) || null,
            }));

            res.json({ success: true, comments });
        } catch (err) {
            console.error("Ошибка при получении комментариев:", err);
            res.status(500).json({ success: false, message: "Ошибка сервера" });
        }
    });
}
