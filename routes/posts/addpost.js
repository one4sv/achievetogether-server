import { authenticateUser } from "../../middleware/token.js";
import multer from "multer";
import { savePost } from "../../utils/savePost.js";

export default function (app, supabase) {
    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { files: 20, fileSize: 100 * 1024 * 1024, fieldSize: 2 * 1024 * 1024 }
    });
    app.post(
        "/addpost",
        authenticateUser(supabase),
        (req, res, next) => req.user?.id ? next() : res.status(401).json({ success: false }),
        upload.array("media"),
        savePost(supabase, false)
    );
}
