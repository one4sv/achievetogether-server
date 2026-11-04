import multer from "multer";
import { randomUUID } from "node:crypto";
import { authenticateUser } from "../../middleware/token.js";

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

const mimeExtensions = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif"
};

export default function (app, supabase) {
    const auth = authenticateUser(supabase);
    const getGallery = async (id) => {
        const { data, error } = await supabase.from("settings")
            .select("bg_gallery, bg_url").eq("user_id", id).maybeSingle();
        if (error) throw error;
        return {
            gallery: Array.isArray(data?.bg_gallery) ? data.bg_gallery : [],
            current: data?.bg_url || ""
        };
    };

    app.post("/uploadbg", auth, upload.single("bg"), async (req, res) => {
        const userId = req.user?.id;
        const file = req.file;
        if (!userId) return res.status(401).json({ success: false, error: "Не авторизован" });
        if (!file || !mimeExtensions[file.mimetype]) {
            return res.status(400).json({ success: false, error: "Поддерживаются JPEG, PNG, WEBP, GIF и AVIF" });
        }

        let filePath = null;
        try {
            const { gallery } = await getGallery(userId);
            if (gallery.length >= 5) {
                return res.status(409).json({ success: false, error: "Можно сохранить не более пяти фонов" });
            }

            filePath = `user_${userId}_bg_${randomUUID()}.${mimeExtensions[file.mimetype]}`;
            const bucket = supabase.storage.from("bgs");
            const { error: uploadError } = await bucket.upload(filePath, file.buffer, {
                contentType: file.mimetype,
                upsert: false
            });
            if (uploadError) throw uploadError;

            const publicUrl = bucket.getPublicUrl(filePath)?.data?.publicUrl;
            if (!publicUrl) throw new Error("Не удалось получить URL фона");

            const next = [...gallery, { path: filePath, url: publicUrl }];
            const { error } = await supabase.from("settings").upsert({
                user_id: userId,
                bg_gallery: next,
                bg_url: publicUrl
            }, { onConflict: "user_id" });
            if (error) throw error;

            return res.json({ success: true, bg_url: publicUrl, bg_gallery: next });
        } catch (error) {
            if (filePath) await supabase.storage.from("bgs").remove([filePath]).catch(() => {});
            console.error("[uploadbg]", error);
            return res.status(500).json({ success: false, error: "Не удалось сохранить фон" });
        }
    });

    app.post("/backgrounds/select", auth, async (req, res) => {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, error: "Не авторизован" });
        const url = req.body?.url;
        if (typeof url !== "string" || url.length > 2048) {
            return res.status(400).json({ success: false, error: "Некорректный фон" });
        }
        try {
            const { gallery } = await getGallery(userId);
            const selected = gallery.find(item => item.url === url);
            if (!selected) return res.status(404).json({ success: false, error: "Фон не найден" });

            const { error } = await supabase.from("settings")
                .update({ bg_url: selected.url }).eq("user_id", userId);
            if (error) throw error;
            return res.json({ success: true, bg_url: selected.url });
        } catch (error) {
            console.error("[backgrounds/select]", error);
            return res.status(500).json({ success: false, error: "Не удалось выбрать фон" });
        }
    });

    app.post("/backgrounds/delete", auth, async (req, res) => {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, error: "Не авторизован" });
        const url = req.body?.url;
        if (typeof url !== "string" || url.length > 2048) {
            return res.status(400).json({ success: false, error: "Некорректный фон" });
        }
        try {
            const { gallery, current } = await getGallery(userId);
            const selected = gallery.find(item => item.url === url);
            if (!selected) return res.status(404).json({ success: false, error: "Фон не найден" });
            const next = gallery.filter(item => item.url !== url);
            const nextCurrent = current === url ? (next[0]?.url || "") : current;
            const { error } = await supabase.from("settings")
                .update({ bg_gallery: next, bg_url: nextCurrent }).eq("user_id", userId);
            if (error) throw error;

            if (typeof selected.path === "string" && selected.path.startsWith(`user_${userId}_bg_`)) {
                const { error: storageError } = await supabase.storage.from("bgs").remove([selected.path]);
                if (storageError) console.error("[backgrounds/delete/storage]", storageError);
            }
            return res.json({ success: true, bg_gallery: next, bg_url: nextCurrent });
        } catch (error) {
            console.error("[backgrounds/delete]", error);
            return res.status(500).json({ success: false, error: "Не удалось удалить фон" });
        }
    });
}
