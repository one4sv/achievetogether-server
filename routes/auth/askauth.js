import bcrypt from "bcrypt";
import { createHmac, randomBytes } from "node:crypto";
import { authenticateUser } from "../../middleware/token.js";
import { authCookie, issueSession } from "../../utils/authSession.js";
import { disconnectUserSockets } from "../../realtime/ws.js";
import { sendMail } from "../../services/sendmail.js";

const hashes = value => createHmac("sha256", process.env.JWT_SECRET).update(String(value)).digest("hex");
const attempts = new Map();
const allowedOrigin = origin => {
    const accepted = (process.env.CLIENT_URL || "https://achievetogether.vercel.app")
        .split(",").map(value => value.trim());
    if (process.env.NODE_ENV !== "production") accepted.push("http://localhost:5173", "http://127.0.0.1:5173");
    return accepted.includes(origin);
};
const guard = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!allowedOrigin(req.get("origin"))) return res.status(403).json({ success: false, error: "Недопустимый источник" });
    const now = Date.now();
    const key = req.ip + ":" + req.path;
    const record = attempts.get(key) || { count: 0, until: now + 15 * 60000 };
    if (record.until < now) { record.count = 0; record.until = now + 15 * 60000; }
    record.count++;
    attempts.set(key, record);
    if (attempts.size > 12000) for (const [id, entry] of attempts) if (entry.until < now) attempts.delete(id);
    if (record.count > 12) return res.status(429).json({ success: false, error: "Попробуйте позже" });
    next();
};
const generateCodes = () => Array.from({ length: 10 }, () =>
    randomBytes(8).toString("hex").toUpperCase().match(/.{1,4}/g).join("-"));
const cleanCode = input => typeof input === "string" ? input.replace(/\s/g, "").toUpperCase() : "";

export default function (app, supabase) {
    const auth = authenticateUser(supabase);

    app.post("/askauth", guard, auth, async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false, error: "Войдите в аккаунт" });
        const password = req.body?.password;
        const mode = req.body?.mode === "backup" ? "backup" : "toggle";
        if (typeof password !== "string" || password.length > 256 || !password) {
            return res.status(400).json({ success: false, error: "Для подтверждения нужен пароль" });
        }
        try {
            const { data: user, error: userError } = await supabase.from("users")
                .select("id,mail,pass").eq("id", req.user.id).single();
            if (userError) throw userError;
            if (!(await bcrypt.compare(password, user.pass))) {
                return res.status(403).json({ success: false, error: "Неверный пароль" });
            }
            const { data: settings, error } = await supabase.from("settings")
                .select("two_auth").eq("user_id", user.id).single();
            if (error) throw error;
            if (mode === "backup" && !settings.two_auth) {
                return res.status(400).json({ success: false, error: "Двухфакторная защита выключена" });
            }
            const action = mode === "backup" ? "two_factor_backup" : "two_factor";
            const token = randomBytes(32).toString("base64url");
            const { error: removeError } = await supabase.from("at_account_actions").delete()
                .eq("user_id", user.id).eq("action", action).is("consumed_at", null);
            if (removeError) throw removeError;
            const { data: change, error: insertError } = await supabase.from("at_account_actions")
                .insert({
                    user_id: user.id,
                    action,
                    code_hash: hashes(token),
                    target_two_factor: mode === "backup" ? true : !settings.two_auth,
                    expires_at: new Date(Date.now() + 15 * 60000).toISOString()
                }).select("id").single();
            if (insertError) throw insertError;
            const origin = (process.env.CLIENT_URL || "https://achievetogether.vercel.app")
                .split(",")[0].trim().replace(/\/$/, "");
            const link = origin + "/settings/2fa#token=" + encodeURIComponent(token) +
                "&action=" + encodeURIComponent(action);
            const description = mode === "backup" ? "создание новых резервных кодов" :
                settings.two_auth ? "отключение" : "включение";
            try {
                await sendMail(user.mail, "Подтверждение 2FA AchieveTogether",
                    "<p>Вы запросили " + description + " двухфакторной аутентификации.</p>" +
                    "<p>Для подтверждения перейдите по ссылке (действительна 15 минут):</p>" +
                    "<p><a href='" + link + "'>Подтвердить действие</a></p>" +
                    "<p>Если это не вы, проигнорируйте письмо.</p>");
            } catch (mailError) {
                await supabase.from("at_account_actions").delete().eq("id", change.id);
                throw Object.assign(new Error("Письмо не отправлено"), { status: 503 });
            }
            return res.json({ success: true, email: user.mail, expiresInMinutes: 15 });
        } catch (error) {
            console.error("[askauth]", error.message);
            return res.status(error.status || 500).json({ success: false, error: error.status === 503 ? error.message : "Не удалось отправить письмо" });
        }
    });

    app.get("/askauth", auth, async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false, error: "Войдите в аккаунт" });
        try {
            const { data: pending, error } = await supabase.from("at_account_actions")
                .select("id,action,expires_at").eq("user_id", req.user.id)
                .in("action", ["two_factor", "two_factor_backup"]).is("consumed_at", null)
                .gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(1);
            if (error) throw error;
            const { count, error: codesError } = await supabase.from("at_2fa_recovery_codes")
                .select("id", { count: "exact", head: true }).eq("user_id", req.user.id).is("used_at", null);
            if (codesError) throw codesError;
            return res.json({
                success: true, isAsked: Boolean(pending?.length),
                expires_at: pending?.[0]?.expires_at || null,
                unusedRecoveryCodes: count || 0
            });
        } catch (error) {
            console.error("[askauth/status]", error.message);
            return res.status(500).json({ success: false, error: "Не удалось получить статус" });
        }
    });

    app.post("/askauth/confirm", guard, auth, async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false, error: "Войдите в аккаунт" });
        const token = req.body?.token;
        const action = req.body?.action;
        if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token) ||
            !["two_factor", "two_factor_backup"].includes(action)) {
            return res.status(400).json({ success: false, error: "Некорректная ссылка" });
        }
        try {
            const backupCodes = generateCodes();
            const { data, error } = await supabase.rpc("at_confirm_two_factor", {
                p_user_id: req.user.id,
                p_action: action,
                p_token_hash: hashes(token),
                p_recovery_hashes: backupCodes.map(code => hashes(code))
            });
            if (error) throw error;
            if (!data?.success) return res.status(400).json({ success: false, error: "Ссылка истекла или недействительна", reason: data?.reason });
            res.clearCookie("token", authCookie);
            disconnectUserSockets(req.user.id);
            return res.json({
                success: true,
                enabled: data.enabled,
                reLogin: true,
                backupCodes: data.enabled ? backupCodes : []
            });
        } catch (error) {
            console.error("[askauth/confirm]", error.message);
            return res.status(500).json({ success: false, error: "Не удалось подтвердить 2FA" });
        }
    });

    app.post("/auth/2fa/recovery-login", guard, async (req, res) => {
        const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
        const password = req.body?.password;
        const backupCode = cleanCode(req.body?.recoveryCode);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
            typeof password !== "string" || password.length > 256 ||
            !/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(backupCode)) {
            return res.status(400).json({ success: false, error: "Неверный формат данных" });
        }
        try {
            const { data: user, error } = await supabase.from("users")
                .select("id,pass,deletion_requested_at").eq("mail", email).maybeSingle();
            if (error) throw error;
            if (!user || user.deletion_requested_at || !(await bcrypt.compare(password, user.pass))) {
                return res.status(401).json({ success: false, error: "Неверные данные" });
            }
            const { data: settings, error: settingsError } = await supabase.from("settings")
                .select("two_auth").eq("user_id", user.id).single();
            if (settingsError) throw settingsError;
            if (!settings.two_auth) return res.status(400).json({ success: false, error: "2FA не включена" });
            const { data: used, error: consumeError } = await supabase.rpc("at_use_2fa_recovery_code", {
                p_user_id: user.id,
                p_code_hash: hashes(backupCode)
            });
            if (consumeError) throw consumeError;
            if (!used) return res.status(403).json({ success: false, error: "Неверный или использованный резервный код" });
            await issueSession(supabase, req, res, user.id, false);
            return res.json({ success: true });
        } catch (error) {
            console.error("[2fa/recovery-login]", error.message);
            return res.status(500).json({ success: false, error: "Не удалось войти" });
        }
    });
}
