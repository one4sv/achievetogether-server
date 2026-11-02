import { authenticateUser } from "../../middleware/token.js";
import { createHash } from "node:crypto";
import { disconnectAuthSession, disconnectUserSockets } from "../../realtime/ws.js";
import { authCookie, issueSession } from "../../utils/authSession.js";

const validOrigin = (req, res, next) => {
    if (req.method === "GET") return next();
    const allowed = (process.env.CLIENT_URL || "https://achievetogether.vercel.app").split(",").map(v => v.trim());
    if (process.env.NODE_ENV !== "production") allowed.push("http://localhost:5173", "http://127.0.0.1:5173");
    if (!allowed.includes(req.get("origin"))) return res.status(403).json({ success: false, error: "Недопустимый источник" });
    next();
};

export default function sessionRoutes(app, supabase) {
    const auth = authenticateUser(supabase);
    app.get("/auth/sessions", auth, async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false, error: "Не авторизован" });
        res.set("Cache-Control", "no-store");
        const { data, error } = await supabase.from("at_user_sessions")
            .select("id,user_agent,ip_address,created_at,last_seen_at,expires_at")
            .eq("user_id", req.user.id).is("revoked_at", null)
            .gt("expires_at", new Date().toISOString()).order("last_seen_at", { ascending: false }).limit(100);
        if (error) return res.status(500).json({ success: false, error: "Не удалось загрузить устройства" });
        const { data: trusted, error: trustedError } = await supabase.from("at_trusted_devices")
            .select("id,session_id,user_agent,ip_address,created_at,last_used_at,expires_at")
            .eq("user_id", req.user.id).gt("expires_at", new Date().toISOString())
            .order("created_at", { ascending: false }).limit(100);
        if (trustedError) return res.status(500).json({ success: false, error: "Не удалось загрузить устройства" });
        const tokenHash = typeof req.cookies?.at_device === "string"
            ? createHash("sha256").update(req.cookies.at_device).digest("hex") : null;
        let currentTrustedId = null;
        if (tokenHash) {
            const { data: ownTrusted } = await supabase.from("at_trusted_devices").select("id")
                .eq("token_hash", tokenHash).eq("user_id", req.user.id).maybeSingle();
            currentTrustedId = ownTrusted?.id || null;
        }
        res.json({
            success: true,
            sessions: (data || []).map(item => ({
                ...item,
                current: item.id === req.sessionId
            })),
            trustedDevices: (trusted || []).map(item => ({
                ...item,
                current: item.id === currentTrustedId
            })),
            legacySession: !req.sessionId
        });
    });
    app.delete("/auth/sessions/:sessionId", validOrigin, auth, async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false, error: "Не авторизован" });
        const id = req.params.sessionId;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return res.status(400).json({ success: false, error: "Неверная сессия" });
        const { data, error } = await supabase.from("at_user_sessions").update({ revoked_at: new Date().toISOString() })
            .eq("id", id).eq("user_id", req.user.id).is("revoked_at", null).select("id");
        if (error) return res.status(500).json({ success: false, error: "Ошибка отзыва" });
        if (!data?.length) return res.status(404).json({ success: false, error: "Сессия не найдена" });
        const { error: linkedError } = await supabase.from("at_trusted_devices").delete()
            .eq("user_id", req.user.id).eq("session_id", id);
        if (linkedError) return res.status(500).json({ success: false, error: "Ошибка отзыва быстрого входа" });
        disconnectAuthSession(id);
        if (id === req.sessionId) {
            res.clearCookie("token", authCookie);
            res.clearCookie("at_device", authCookie);
        }
        res.json({ success: true, current: id === req.sessionId });
    });
    app.delete("/auth/trusted-devices/:deviceId", validOrigin, auth, async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false, error: "Не авторизован" });
        const id = req.params.deviceId;
        if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ success: false, error: "Неверное устройство" });
        const { data, error } = await supabase.from("at_trusted_devices").delete()
            .eq("id", id).eq("user_id", req.user.id).select("id,token_hash");
        if (error) return res.status(500).json({ success: false, error: "Ошибка отзыва быстрого входа" });
        if (!data?.length) return res.status(404).json({ success: false, error: "Устройство не найдено" });
        if (typeof req.cookies?.at_device === "string" &&
            createHash("sha256").update(req.cookies.at_device).digest("hex") === data[0].token_hash) {
            res.clearCookie("at_device", authCookie);
        }
        return res.json({ success: true });
    });

    app.post("/auth/sessions/logout-others", validOrigin, auth, async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false, error: "Не авторизован" });
        try {
            const { data: user, error: userError } = await supabase.from("users")
                .select("auth_version").eq("id", req.user.id).single();
            if (userError) throw userError;
            const { error: updateError } = await supabase.from("users")
                .update({ auth_version: (user.auth_version || 1) + 1 }).eq("id", req.user.id);
            if (updateError) throw updateError;
            const { error: revokeError } = await supabase.from("at_user_sessions")
                .update({ revoked_at: new Date().toISOString() }).eq("user_id", req.user.id).is("revoked_at", null);
            if (revokeError) throw revokeError;
            const { error: deviceError } = await supabase.from("at_trusted_devices")
                .delete().eq("user_id", req.user.id);
            if (deviceError) throw deviceError;
            await issueSession(supabase, req, res, req.user.id);
            disconnectUserSockets(req.user.id);
            res.clearCookie("at_device", authCookie);
            return res.json({ success: true });
        } catch (error) {
            console.error("Session revocation failed:", error?.message);
            return res.status(500).json({ success: false, error: "Ошибка завершения сессий" });
        }
    });
}
