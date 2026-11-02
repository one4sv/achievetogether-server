import { createHash, randomBytes } from "node:crypto";
import { authenticateUser } from "../../middleware/token.js";

const hash = token => createHash("sha256").update(token).digest("hex");

export default function wsTicketRoutes(app, supabase) {
    app.post("/auth/ws-ticket", authenticateUser(supabase), async (req, res) => {
        res.set("Cache-Control", "no-store");
        const allowed = (process.env.CLIENT_URL || "https://achievetogether.vercel.app").split(",").map(v => v.trim());
        if (process.env.NODE_ENV !== "production") allowed.push("http://localhost:5173", "http://127.0.0.1:5173");
        if (!allowed.includes(req.get("origin"))) return res.status(403).json({ success: false });
        if (!req.user?.id) return res.status(401).json({ success: false });
        try {
            const ticket = randomBytes(32).toString("base64url");
            const { error } = await supabase.from("at_ws_tickets").insert({
                token_hash: hash(ticket),
                user_id: req.user.id,
                session_id: req.sessionId,
                auth_version: req.user.v || 1,
                expires_at: new Date(Date.now() + 45 * 1000).toISOString()
            });
            if (error) throw error;
            res.json({ success: true, ticket });
        } catch (error) {
            console.error("WS ticket error:", error?.message);
            res.status(500).json({ success: false });
        }
    });
}
