import jwt from "jsonwebtoken";

export const authCookie = {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "test",
    sameSite: process.env.NODE_ENV === "test" ? "lax" : "none",
    path: "/"
};

export async function issueSession(supabase, req, res, userId, remember = true) {
    const { data: user, error: userError } = await supabase.from("users").select("auth_version").eq("id", userId).single();
    if (userError || !user) throw userError || new Error("User not found");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: session, error } = await supabase.from("at_user_sessions").insert({
        user_id: userId,
        user_agent: (req.get("user-agent") || "").slice(0, 500),
        ip_address: req.ip || null,
        expires_at: expiresAt
    }).select("id").single();
    if (error) throw error;

    const token = jwt.sign({ id: userId, sid: session.id, v: user.auth_version || 1 },
        process.env.JWT_SECRET, { expiresIn: "30d" });
    res.cookie("token", token, {
        ...authCookie,
        ...(remember ? { maxAge: 30 * 24 * 60 * 60 * 1000 } : {})
    });
    return session.id;
}

export async function revokeUserSessions(supabase, userId) {
    const now = new Date().toISOString();
    const { error } = await supabase.from("at_user_sessions").update({ revoked_at: now })
        .eq("user_id", userId).is("revoked_at", null);
    if (error) throw error;
    const { error: trustedError } = await supabase.from("at_trusted_devices").delete().eq("user_id", userId);
    if (trustedError) throw trustedError;
}
