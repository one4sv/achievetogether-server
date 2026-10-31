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

            const commentIds = commentsData.map(comment => comment.id);
            const { data: likes, error: likesError } = await supabase
                .from("post_comment_likes")
                .select("comment_id, user_id")
                .in("comment_id", commentIds);
            if (likesError) throw likesError;
            const likesByComment = new Map();
            for (const like of likes || []) {
                const group = likesByComment.get(like.comment_id) || [];
                group.push(like.user_id);
                likesByComment.set(like.comment_id, group);
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
    app.post("/comments/:id/like", authenticateUser(supabase), async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false });
        try {
            const { data: comment, error: readError } = await supabase
                .from("posts_comments").select("id, post_id").eq("id", req.params.id).maybeSingle();
            if (readError) throw readError;
            if (!comment || !await readablePost(supabase, comment.post_id, req.user.id)) {
                return res.status(404).json({ success: false });
            }
            const { data: previous, error: checkError } = await supabase
                .from("post_comment_likes").select("comment_id")
                .eq("comment_id", comment.id).eq("user_id", req.user.id).maybeSingle();
            if (checkError) throw checkError;
            if (previous) {
                const { error } = await supabase.from("post_comment_likes").delete()
                    .eq("comment_id", comment.id).eq("user_id", req.user.id);
                if (error) throw error;
                return res.json({ success: true, liked: false });
            }
            const { error } = await supabase.from("post_comment_likes")
                .upsert({ comment_id: comment.id, user_id: req.user.id }, { onConflict: "comment_id,user_id" });
            if (error) throw error;
            res.json({ success: true, liked: true });
        } catch (error) {
            console.error("Ошибка лайка комментария:", error);
            res.status(500).json({ success: false });
        }
    });

    app.patch("/comments/:id", authenticateUser(supabase), async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false });
        const text = req.body?.text;
        if (typeof text !== "string" || !text.trim() || text.length > 10000) {
            return res.status(400).json({ success: false, error: "Некорректный текст" });
        }
        try {
            const { data: original, error: findError } = await supabase
                .from("posts_comments")
                .select("id, post_id, user_id")
                .eq("id", req.params.id)
                .maybeSingle();
            if (findError) throw findError;
            if (!original) return res.status(404).json({ success: false });
            if (original.user_id !== req.user.id) return res.status(403).json({ success: false });
            if (!await readablePost(supabase, original.post_id, req.user.id)) {
                return res.status(404).json({ success: false });
            }
            const { data, error } = await supabase.from("posts_comments")
                .update({ text: text.trim() })
                .eq("id", original.id)
                .eq("user_id", req.user.id)
                .select("*")
                .single();
            if (error) throw error;
            res.json({ success: true, comment: data });
        } catch (error) {
            console.error("Ошибка редактирования комментария:", error);
            res.status(500).json({ success: false });
        }
    });

    app.delete("/comments/:id", authenticateUser(supabase), async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false });
        try {
            const { data: original, error: findError } = await supabase
                .from("posts_comments")
                .select("id, post_id, user_id")
                .eq("id", req.params.id)
                .maybeSingle();
            if (findError) throw findError;
            if (!original) return res.status(404).json({ success: false });
            if (original.user_id !== req.user.id) return res.status(403).json({ success: false });
            if (!await readablePost(supabase, original.post_id, req.user.id)) {
                return res.status(404).json({ success: false });
            }
            const { error } = await supabase.from("posts_comments")
                .delete().eq("id", original.id).eq("user_id", req.user.id);
            if (error) throw error;
            res.json({ success: true });
        } catch (error) {
            console.error("Ошибка удаления комментария:", error);
            res.status(500).json({ success: false });
        }
    });

}
