import { authenticateUser } from "../../middleware/token.js";
import { endpointHash, publicVapidKey, validPushSubscription } from "../../utils/webPush.js";

const allowedOrigin = origin => {
    const origins = (process.env.CLIENT_URL || "https://achievetogether.vercel.app").split(",").map(value => value.trim());
    if (process.env.NODE_ENV !== "production") origins.push("http://localhost:5173", "http://127.0.0.1:5173");
    return origins.includes(origin);
};

export default function pushRoutes(app, supabase) {
    const auth = authenticateUser(supabase);
    const protect = (req, res, next) => {
        if (!req.user?.id || !req.sessionId) return res.status(401).json({ success: false, error: "Sign in again" });
        if (!allowedOrigin(req.get("origin"))) return res.status(403).json({ success: false, error: "Origin rejected" });
        return next();
    };

    app.get("/push/config", (req, res) => {
        res.set("Cache-Control", "no-store");
        const publicKey = publicVapidKey();
        res.json({ success: true, enabled: !!publicKey, publicKey });
    });

    app.get("/push/status", auth, async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false });
        const hash = typeof req.query.endpoint === "string" && req.query.endpoint.length <= 2048
            ? endpointHash(req.query.endpoint) : null;
        if (!hash) return res.json({ success: true, subscribed: false });
        const { data, error } = await supabase.from("at_push_subscriptions")
            .select("endpoint_hash").eq("user_id", req.user.id).eq("endpoint_hash", hash).maybeSingle();
        if (error) return res.status(500).json({ success: false });
        res.json({ success: true, subscribed: !!data });
    });

    app.post("/push/subscribe", auth, protect, async (req, res) => {
        const subscription = req.body?.subscription;
        if (!validPushSubscription(subscription)) return res.status(400).json({ success: false, error: "Invalid subscription" });
        if (!publicVapidKey()) return res.status(503).json({ success: false, error: "Push not configured" });
        const hash = endpointHash(subscription.endpoint);
        try {
            const { count, error: countError } = await supabase.from("at_push_subscriptions")
                .select("endpoint_hash", { count: "exact", head: true }).eq("user_id", req.user.id);
            if (countError) throw countError;
            const { data: current, error: existsError } = await supabase.from("at_push_subscriptions")
                .select("endpoint_hash").eq("endpoint_hash", hash).maybeSingle();
            if (existsError) throw existsError;
            if (!current && (count || 0) >= 10) return res.status(429).json({ success: false, error: "Device limit reached" });
            const { error } = await supabase.from("at_push_subscriptions").upsert({
                endpoint: subscription.endpoint,
                endpoint_hash: hash,
                p256dh: subscription.keys.p256dh,
                auth: subscription.keys.auth,
                expiration_time: subscription.expirationTime ?? null,
                user_id: req.user.id,
                session_id: req.sessionId,
                updated_at: new Date().toISOString()
            }, { onConflict: "endpoint_hash" });
            if (error) throw error;
            res.json({ success: true });
        } catch (error) {
            console.error("Push subscribe failed:", error.message);
            res.status(500).json({ success: false });
        }
    });

    app.post("/push/unsubscribe", auth, protect, async (req, res) => {
        const endpoint = req.body?.endpoint;
        if (typeof endpoint !== "string" || endpoint.length > 2048 || !endpoint) {
            return res.status(400).json({ success: false });
        }
        const { error } = await supabase.from("at_push_subscriptions").delete()
            .eq("user_id", req.user.id).eq("endpoint_hash", endpointHash(endpoint));
        if (error) return res.status(500).json({ success: false });
        res.json({ success: true });
    });
}
