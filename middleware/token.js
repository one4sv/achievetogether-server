import jwt from "jsonwebtoken";

export function authenticateUser(supabase) {
    return async function (req, res, next) {
        const token = req.cookies?.token;
        req.user = null;
        req.sessionId = null;
        if (!token) return next();

        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            if (typeof decoded !== "object" || !decoded.id) return next();

            const { data: user, error: userError } = await supabase.from("users")
                .select("auth_version,deletion_requested_at").eq("id", decoded.id).maybeSingle();
            if (userError || !user || user.deletion_requested_at) return next();
            const currentVersion = user.auth_version || 1;
            if ((decoded.v || 1) !== currentVersion) return next();

            if (decoded.sid) {
                const { data: session, error } = await supabase.from("at_user_sessions")
                    .select("id,last_seen_at").eq("id", decoded.sid).eq("user_id", decoded.id)
                    .is("revoked_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
                if (error || !session) return next();
                req.sessionId = session.id;
                if (Date.now() - new Date(session.last_seen_at).getTime() > 300000) {
                    await supabase.from("at_user_sessions").update({ last_seen_at: new Date().toISOString() })
                        .eq("id", session.id).is("revoked_at", null);
                }
            } else if (currentVersion !== 1) {
                // Previously issued JWTs remain valid only until a password change.
                return next();
            }

            req.user = decoded;
        } catch {
            // Invalid, expired or revoked JWT is treated as unauthenticated.
        }
        return next();
    };
}
