import { authenticateUser } from "../../middleware/token.js";
import { authCookie } from "../../utils/authSession.js";
import { disconnectAuthSession } from "../../realtime/ws.js";

export default function (app, supabase) {
    app.get("/logout", authenticateUser(supabase), async (req, res) => {
        if (req.sessionId) {
            const { error } = await supabase.from("at_user_sessions").update({
                revoked_at: new Date().toISOString()
            }).eq("id", req.sessionId).eq("user_id", req.user.id);
            if (error) return res.status(500).json({ success: false, error: "Ошибка выхода" });
            disconnectAuthSession(req.sessionId);
        }
        res.clearCookie("token", authCookie);
        res.json({ success: true, message: "Вы вышли из системы" });
    });
}
