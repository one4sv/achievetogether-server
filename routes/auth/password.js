import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import { authenticateUser } from "../../middleware/token.js";
import { authCookie, revokeUserSessions } from "../../utils/authSession.js";
import { sendMail } from "../../services/sendmail.js";
import { disconnectUserSockets } from "../../realtime/ws.js";

const hash = value => createHash("sha256").update(value).digest("hex");
const validPass = value => typeof value === "string" && value.length >= 8 && value.length <= 30
    && /^[A-Za-z0-9]+$/.test(value) && /[A-Za-z]/.test(value) && /[0-9]/.test(value);
const attempts = new Map();

const guard = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const allowed = (process.env.CLIENT_URL || "https://achievetogether.vercel.app").split(",").map(x => x.trim());
    if (process.env.NODE_ENV !== "production") allowed.push("http://localhost:5173", "http://127.0.0.1:5173");
    if (!allowed.includes(req.get("origin"))) return res.status(403).json({ success: false, error: "Недопустимый источник" });
    const now = Date.now(), key = req.ip + req.path;
    let entry = attempts.get(key);
    if (!entry || now > entry.until) entry = { count: 0, until: now + 15 * 60000 };
    entry.count += 1;
    attempts.set(key, entry);
    if (attempts.size > 10000) for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
    if (entry.count > 12) return res.status(429).json({ success: false, error: "Слишком много запросов" });
    next();
};

export default function passwordRoutes(app, supabase) {
    const auth = authenticateUser(supabase);

    app.post("/auth/password/forgot", guard, async (req, res) => {
        const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
        if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ success: false, error: "Некорректный email" });
        }
        const response = { success: true, message: "Если аккаунт существует, письмо отправлено" };
        if (!(process.env.SENDGRID_API_KEY && process.env.MAIL_FROM) &&
            !(process.env.GOOGLE_REFRESH_TOKEN && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)) {
            return res.status(503).json({ success: false, error: "Почтовый сервис недоступен" });
        }
        try {
            const { data: user, error } = await supabase.from("users").select("id,mail").eq("mail", email).maybeSingle();
            if (error) throw error;
            if (!user) return res.json(response);
            const { data: recent, error: checkError } = await supabase.from("at_password_resets")
                .select("id").eq("user_id", user.id)
                .gt("created_at", new Date(Date.now() - 5 * 60000).toISOString()).limit(1);
            if (checkError) throw checkError;
            if (recent?.length) return res.json(response);
            const token = randomBytes(32).toString("base64url");
            const { error: insertError } = await supabase.from("at_password_resets").insert({
                user_id: user.id,
                token_hash: hash(token),
                expires_at: new Date(Date.now() + 20 * 60000).toISOString()
            });
            if (insertError) throw insertError;
            const origin = (process.env.CLIENT_URL || "https://achievetogether.vercel.app").split(",")[0].trim().replace(/\/$/, "");
            const link = origin + "/reset-password#token=" + token;
            try {
                await sendMail(user.mail, "Восстановление пароля AchieveTogether",
                    '<p>Вы запросили смену пароля.</p><p><a href="' + link +
                    '">Создать новый пароль</a></p><p>Ссылка действительна 20 минут. Если запрос был не ваш, проигнорируйте письмо.</p>');
            } catch (mailError) {
                await supabase.from("at_password_resets").delete().eq("token_hash", hash(token));
                console.error("Password email delivery failed:", mailError?.message);
            }
            return res.json(response);
        } catch (error) {
            console.error("Password recovery failed:", error?.message);
            return res.status(500).json({ success: false, error: "Не удалось обработать запрос" });
        }
    });

    app.post("/auth/password/reset", guard, async (req, res) => {
        const { token, password } = req.body || {};
        if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token) || !validPass(password)) {
            return res.status(400).json({ success: false, error: "Неверная ссылка или формат пароля" });
        }
        try {
            const now = new Date().toISOString();
            const { data: records, error } = await supabase.from("at_password_resets")
                .update({ used_at: now }).eq("token_hash", hash(token))
                .is("used_at", null).gt("expires_at", now).select("id,user_id");
            if (error) throw error;
            if (!records?.length) return res.status(410).json({ success: false, error: "Ссылка недействительна или истекла" });
            const userId = records[0].user_id;
            const { data: user, error: lookupError } = await supabase.from("users")
                .select("auth_version").eq("id", userId).single();
            if (lookupError) throw lookupError;
            const { error: updateError } = await supabase.from("users")
                .update({ pass: await bcrypt.hash(password, 12), auth_version: user.auth_version + 1 })
                .eq("id", userId);
            if (updateError) throw updateError;
            await revokeUserSessions(supabase, userId);
            disconnectUserSockets(userId);
            return res.json({ success: true });
        } catch (error) {
            console.error("Password reset failed:", error?.message);
            return res.status(500).json({ success: false, error: "Не удалось изменить пароль" });
        }
    });

    app.post("/auth/password/change", guard, auth, async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false, error: "Не авторизован" });
        const { currentPassword, newPassword } = req.body || {};
        if (!validPass(newPassword) || typeof currentPassword !== "string" || currentPassword.length > 256) {
            return res.status(400).json({ success: false, error: "Неверный формат пароля" });
        }
        try {
            const { data: user, error } = await supabase.from("users")
                .select("pass,auth_version").eq("id", req.user.id).single();
            if (error || !user) return res.status(401).json({ success: false, error: "Не авторизован" });
            if (!(await bcrypt.compare(currentPassword, user.pass))) {
                return res.status(403).json({ success: false, error: "Неверный текущий пароль" });
            }
            if (await bcrypt.compare(newPassword, user.pass)) {
                return res.status(400).json({ success: false, error: "Новый пароль совпадает со старым" });
            }
            const { error: updateError } = await supabase.from("users")
                .update({ pass: await bcrypt.hash(newPassword, 12), auth_version: user.auth_version + 1 })
                .eq("id", req.user.id);
            if (updateError) throw updateError;
            await revokeUserSessions(supabase, req.user.id);
            disconnectUserSockets(req.user.id);
            res.clearCookie("token", authCookie);
            return res.json({ success: true, message: "Пароль изменён. Войдите заново." });
        } catch (error) {
            console.error("Password change failed:", error?.message);
            return res.status(500).json({ success: false, error: "Не удалось изменить пароль" });
        }
    });
}
