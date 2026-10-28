import { readablePost, signedMedia } from "../../utils/postContent.js";
import multer from "multer";
import { authenticateUser } from "../../middleware/token.js";

const upload = multer({ storage: multer.memoryStorage() });

export default function (app, supabase) {
    app.post("/sendcomment", authenticateUser(supabase), upload.array("media"), async (req, res) => {
        try {
            if (!req.user?.id) return res.status(401).json({ success: false });
            if (!await readablePost(supabase, req.body.id, req.user.id)) return res.status(404).json({ success: false });
            const { id: user_id } = req.user;
            const { id, text } = req.body; // id = post_id
            if (!id) {
                return res.status(400).json({ success: false, error: "Не указан post_id" });
            }

            const files = [];
            if (req.files && req.files.length > 0) {
                for (const file of req.files) {
                    const safeName = file.originalname
                        .normalize("NFD")
                        .replace(/[^a-zA-Z0-9._-]/g, "_");

                    const filePath = `comments/${Date.now()}_${safeName}`;

                    const { error: uploadError } = await supabase.storage
                        .from("comments")
                        .upload(filePath, file.buffer, {
                            contentType: file.mimetype,
                        });

                    if (uploadError) throw uploadError;

                    const { data: publicUrl } = supabase.storage
                        .from("comments")
                        .getPublicUrl(filePath);

                    files.push({
                        name: file.originalname,
                        type: file.mimetype,
                        url: publicUrl.publicUrl,
                    });
                }
            }

            // вставляем сам комментарий
            const { data, error } = await supabase
                .from("posts_comments")
                .insert([
                    {
                        post_id: id,
                        text: text || null,
                        files: files.length > 0 ? files : null,
                        user_id: user_id,
                    },
                ])
                .select("*")
                .single();

            if (error) throw error;

            // 🔥 теперь добавляем данные пользователя
            const { data: userData, error: userError } = await supabase
                .from("users")
                .select("id, username, nick, avatar_url")
                .eq("id", user_id)
                .single();

            if (userError) throw userError;

            // собираем финальный объект
            const comment = {
                ...data,
                files: await signedMedia(supabase, data.files, "comments"),
                user: userData,
            };

            res.json({
                success: true,
                comment,
            });
        } catch (err) {
            console.error("Ошибка при добавлении комментария:", err);
            res.status(500).json({
                success: false,
                error: err.message,
            });
        }
    });
}
