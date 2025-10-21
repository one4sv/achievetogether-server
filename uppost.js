import { authenticateUser } from "./middleware/token.js";
import multer from "multer";
import crypto from "crypto";
import path from "path";

export default function (app, supabase) {
    const upload = multer({ storage: multer.memoryStorage() });

    app.post("/uppost", authenticateUser(supabase), upload.array("media"), async (req, res) => {
        try {
            const { id: user_id } = req.user;
            const { id: post_id, text, keptMedia: keptStr } = req.body;
            const keptMedia = keptStr ? JSON.parse(keptStr) : [];
            const files = req.files || [];

            // Проверка поста и владения
            const { data: post, error: postError } = await supabase
                .from("posts")
                .select("*")
                .eq("id", post_id)
                .single();
            if (postError || !post || post.user_id !== user_id) {
                return res.status(403).json({ success: false, message: "Это не ваш пост" });
            }

            // Проверка на пустоту
            if ((!text || !text.trim()) && (keptMedia.length + files.length === 0)) {
                return res.status(400).json({ success: false, message: "Пост не может быть пустым" });
            }

            // Удаление удаленных медиа из хранилища
            const currentMedia = post.media || [];
            const toDelete = currentMedia
                .filter(m => !keptMedia.some(k => k.url === m.url))
                .map(m => {
                    const url = new URL(m.url);
                    return url.pathname.split("/storage/v1/object/public/posts/")[1];
                });
            if (toDelete.length > 0) {
                const { error: deleteError } = await supabase.storage.from("posts").remove(toDelete);
                if (deleteError) throw deleteError;
            }

            // Загрузка новых медиа
            let newMedia = [...keptMedia];
            for (const file of files) {
                const ext = path.extname(file.originalname);
                const uniqueName = crypto.randomUUID() + ext;
                const filePath = `${user_id}/${post_id}/${uniqueName}`;
                const { error: uploadError } = await supabase.storage
                    .from("posts")
                    .upload(filePath, file.buffer, { contentType: file.mimetype });
                if (uploadError) throw uploadError;
                const { data: { publicUrl } } = supabase.storage.from("posts").getPublicUrl(filePath);
                newMedia.push({
                    name: file.originalname,
                    type: file.mimetype,
                    url: publicUrl,
                });
            }

            // Обновление поста
            const { error: updateError } = await supabase
                .from("posts")
                .update({ text, media: newMedia })
                .eq("id", post_id);
            if (updateError) throw updateError;

            res.status(200).json({ success: true });
        } catch (err) {
            console.error("❌ Ошибка обновления поста:", err);
            res.status(500).json({ success: false, message: err.message });
        }
    });
}