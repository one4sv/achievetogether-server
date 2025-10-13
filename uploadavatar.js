import multer from "multer";
import path from "path";
import { authenticateUser } from "./middleware/token.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB
});

export default function(app, supabase) {
  app.post("/uploadavatar", authenticateUser(supabase), upload.single("avatar"), async (req, res) => {
    try {
      console.log("[uploadavatar] called, user:", req.user?.id);
      const file = req.file;
      if (!file) {
        console.warn("[uploadavatar] no file in request");
        return res.status(400).json({ success: false, error: "No file uploaded" });
      }

      console.log("[uploadavatar] file:", { originalname: file.originalname, mimetype: file.mimetype, size: file.size });

      const userId = req.user.id;
      const ext = path.extname(file.originalname) || ".png";
      const filename = `user_${userId}_${Date.now()}${ext}`;
      const bucket = "avatars";
      const filePath = filename;

      // upload to Supabase storage — include contentType
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(filePath, file.buffer, { contentType: file.mimetype, upsert: true });

      console.log("[uploadavatar] uploadData:", uploadData, "uploadError:", uploadError);
      if (uploadError) {
        console.error("[uploadavatar] storage upload error:", uploadError);
        return res.status(500).json({ success: false, error: "Storage upload error", detail: uploadError });
      }

      // since bucket is public -> getPublicUrl returns usable link; save it in DB
      const publicRes = await supabase.storage.from(bucket).getPublicUrl(filePath);
      const publicUrl = (publicRes?.data && (publicRes.data.publicUrl || publicRes.data.publicURL)) || publicRes?.publicUrl || publicRes?.publicURL;
      console.log("[uploadavatar] publicUrl:", publicUrl);

      if (!publicUrl) {
        console.error("[uploadavatar] no publicUrl returned");
        return res.status(500).json({ success: false, error: "No public URL" });
      }

      // update user's avatar_url in DB with the public url
      const { data, error } = await supabase
        .from("users")
        .update({ avatar_url: publicUrl })
        .eq("id", userId)
        .select()
        .single();

      console.log("[uploadavatar] db update:", { data, error });
      if (error) {
        console.error("[uploadavatar] Supabase update avatar_url error:", error);
        return res.status(500).json({ success: false, error: "DB update error", detail: error });
      }

      // Возвращаем signedUrl клиенту, и путь сохранённый в БД
      return res.json({ success: true, avatar_url: publicUrl, user: data });
    } catch (err) {
      console.error("[uploadavatar] unexpected error:", err);
      return res.status(500).json({ success: false, error: "Server error", detail: String(err) });
    }
  });
}