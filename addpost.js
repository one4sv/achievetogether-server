import { authenticateUser } from "./middleware/token.js";
import multer from "multer";
import crypto from "crypto";
import path from "path";

export default function (app, supabase) {
  const upload = multer({ storage: multer.memoryStorage() });

  app.post("/addpost", authenticateUser(supabase), upload.array("media"), async (req, res) => {
    try {
      const { id: user_id } = req.user;
      const { text, habit_id } = req.body;
      const files = req.files || [];

      if ((!text || !text.trim()) && files.length === 0) {
        return res.status(400).json({ success: false, message: "Пост не может быть пустым" });
      }

      const { data: postData, error: postError } = await supabase
        .from("posts")
        .insert([{ user_id, text, habit_id: habit_id !== "none" ? habit_id : null, media: [] }])
        .select("id")
        .single();

      if (postError) throw postError;
      const post_id = postData.id;

      let media = [];
      for (const file of files) {
        const ext = path.extname(file.originalname);
        const uniqueName = crypto.randomUUID() + ext;
        const filePath = `${user_id}/${post_id}/${uniqueName}`;

        const { error: uploadError } = await supabase.storage
          .from("posts")
          .upload(filePath, file.buffer, { contentType: file.mimetype });

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
          .from("posts")
          .getPublicUrl(filePath);

        media.push({
          name: file.originalname,
          type: file.mimetype,
          url: publicUrl,
        });
      }

      if (media.length > 0) {
        const { error: updateError } = await supabase
          .from("posts")
          .update({ media })
          .eq("id", post_id);

        if (updateError) throw updateError;
      }

      res.status(200).json({ success: true, post_id });
    } catch (err) {
      console.error("❌ Ошибка добавления поста:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  });
}
