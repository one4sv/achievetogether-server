import multer from "multer";
import path from "path";
import { authenticateUser } from "./middleware/token.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB для фона, можно больше чем для авы
});

export default function (app, supabase) {
  app.post("/uploadbg", authenticateUser(supabase), upload.single("bg"), async (req, res) => {
    try {
      console.log("[uploadbg] called, user:", req.user?.id);
      const file = req.file;
      if (!file) {
        console.warn("[uploadbg] no file in request");
        return res.status(400).json({ success: false, error: "No file uploaded" });
      }

      console.log("[uploadbg] file:", { originalname: file.originalname, mimetype: file.mimetype, size: file.size });

      const userId = req.user.id;
      const ext = path.extname(file.originalname) || ".png";
      const filename = `user_${userId}_bg_${Date.now()}${ext}`;
      const bucket = "bgs";
      const filePath = filename;

      // upload to Supabase storage
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(filePath, file.buffer, { contentType: file.mimetype, upsert: true });

      console.log("[uploadbg] uploadData:", uploadData, "uploadError:", uploadError);
      if (uploadError) {
        console.error("[uploadbg] storage upload error:", uploadError);
        return res.status(500).json({ success: false, error: "Storage upload error", detail: uploadError });
      }

      // public url
      const publicRes = await supabase.storage.from(bucket).getPublicUrl(filePath);
      const publicUrl = (publicRes?.data && (publicRes.data.publicUrl || publicRes.data.publicURL)) 
        || publicRes?.publicUrl 
        || publicRes?.publicURL;

      console.log("[uploadbg] publicUrl:", publicUrl);
      if (!publicUrl) {
        console.error("[uploadbg] no publicUrl returned");
        return res.status(500).json({ success: false, error: "No public URL" });
      }

    //   update user's background_url
      const { data, error } = await supabase
        .from("settings")
        .update({ bg_url: publicUrl })
        .eq("user_id", userId)
        .select()
        .single();

      console.log("[uploadbg] db update:", { data, error });
      if (error) {
        console.error("[uploadbg] Supabase update background_url error:", error);
        return res.status(500).json({ success: false, error: "DB update error", detail: error });
      }

      return res.json({ success: true});
    } catch (err) {
      console.error("[uploadbg] unexpected error:", err);
      return res.status(500).json({ success: false, error: "Server error", detail: String(err) });
    }
  });
}
