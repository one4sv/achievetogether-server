import bcrypt from "bcrypt";
import { createHmac, randomInt } from "node:crypto";
import { authenticateUser } from "../../middleware/token.js";
import { authCookie, issueSession } from "../../utils/authSession.js";
import { disconnectUserSockets } from "../../realtime/ws.js";
import { sendMail } from "../../services/sendmail.js";

const DAY = 86400000;
const attempts = new Map();
const codeHash = code => createHmac("sha256", process.env.JWT_SECRET).update(String(code)).digest("hex");
const validEmail = value => typeof value === "string" && value.length <= 254 && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value);
const validPassword = value => typeof value === "string" && value.length <= 256 && value.length > 0;
const validCode = value => typeof value === "string" && /^\\d{6}$/.test(value);
const emailValue = value => typeof value === "string" ? value.trim().toLowerCase() : "";
const mailReady = () => Boolean(
    (process.env.RESEND_API_KEY && (process.env.RESEND_FROM_EMAIL || process.env.MAIL_FROM)) ||
    (process.env.BREVO_API_KEY && (process.env.BREVO_SENDER_EMAIL || process.env.MAIL_FROM)) ||
    (process.env.SENDGRID_API_KEY && process.env.MAIL_FROM) ||
    (process.env.GOOGLE_REFRESH_TOKEN && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
);

const guard = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const origins = (process.env.CLIENT_URL || "https://achievetogether.vercel.app")
        .split(",").map(value => value.trim());
    if (process.env.NODE_ENV !== "production") origins.push("http://localhost:5173", "http://127.0.0.1:5173");
    if (!origins.includes(req.get("origin"))) return res.status(403).json({ success: false, error: "Недопустимый источник" });
    const now = Date.now();
    const key = req.ip + ":" + req.path;
    let record = attempts.get(key);
    if (!record || record.until < now) record = { count: 0, until: now + 15 * 60000 };
    record.count++;
    attempts.set(key, record);
    if (attempts.size > 12000) {
        for (const [id, entry] of attempts) if (entry.until < now) attempts.delete(id);
    }
    if (record.count > 12) return res.status(429).json({ success: false, error: "Слишком много запросов. Повторите позже." });
    next();
};

const getVerifiedUser = async (supabase, id, password, allowPending = false) => {
    const { data: user, error } = await supabase.from("users")
        .select("id,mail,pass,deletion_requested_at").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!user || !validPassword(password) || !(await bcrypt.compare(password, user.pass))) return null;
    if (!allowPending && user.deletion_requested_at) return null;
    return user;
};

const makeAction = async (supabase, user, action, destination, targetEmail = null) => {
    if (!mailReady()) throw Object.assign(new Error("Почтовый сервис недоступен"), { status: 503 });
    const code = String(randomInt(100000, 1000000));
    const { error: removeError } = await supabase.from("at_account_actions").delete()
        .eq("user_id", user.id).eq("action", action).is("consumed_at", null);
    if (removeError) throw removeError;
    const { data: row, error } = await supabase.from("at_account_actions").insert({
        user_id: user.id,
        action,
        target_email: targetEmail,
        code_hash: codeHash(code),
        expires_at: new Date(Date.now() + 15 * 60000).toISOString()
    }).select("id").single();
    if (error) throw error;
    const subject = action === "delete" ? "Удаление аккаунта AchieveTogether" :
        action === "recover" ? "Восстановление аккаунта AchieveTogether" : "Подтверждение нового email AchieveTogether";
    const message = action === "delete" ? "подтверждения удаления аккаунта" :
        action === "recover" ? "восстановления аккаунта" : "подтверждения нового адреса почты";
    try {
        await sendMail(destination, subject,
            "<p>Код для " + message + ":</p><p style='font-size:24px;letter-spacing:4px'>" +
            code + "</p><p>Действителен 15 минут. Если вы не делали запрос, проигнорируйте письмо.</p>");
    } catch (error) {
        await supabase.from("at_account_actions").delete().eq("id", row.id);
        throw Object.assign(new Error("Не удалось отправить письмо"), { status: 503 });
    }
};

const finish = async (supabase, userId, action, code, deleteMessages = false) => {
    const { data, error } = await supabase.rpc("at_consume_account_action", {
        p_user_id: userId,
        p_action: action,
        p_code_hash: codeHash(code),
        p_delete_messages: deleteMessages
    });
    if (error) throw error;
    return data;
};

export default function accountSecurityRoutes(app, supabase) {
    const auth = authenticateUser(supabase);

    app.post("/auth/account/email/request", guard, auth, async (req, res) => {
        const newEmail = emailValue(req.body?.email);
        if (!req.user?.id) return res.status(401).json({ success: false, error: "Войдите в аккаунт" });
        if (!validEmail(newEmail) || !validPassword(req.body?.password)) {
            return res.status(400).json({ success: false, error: "Некорректная почта или пароль" });
        }
        try {
            const user = await getVerifiedUser(supabase, req.user.id, req.body.password);
            if (!user) return res.status(403).json({ success: false, error: "Неверный пароль" });
            if (user.mail.toLowerCase() === newEmail) return res.status(400).json({ success: false, error: "Это текущий адрес" });
            const { data: existing, error } = await supabase.from("users").select("id")
                .ilike("mail", newEmail).maybeSingle();
            if (error) throw error;
            if (existing) return res.status(409).json({ success: false, error: "Адрес уже занят" });
            await makeAction(supabase, user, "email_change", newEmail, newEmail);
            return res.json({ success: true, email: newEmail, expiresInMinutes: 15 });
        } catch (error) {
            console.error("[account/email/request]", error.message);
            return res.status(error.status || 500).json({ success: false, error: error.status === 503 ? error.message : "Не удалось отправить подтверждение" });
        }
    });

    app.post("/auth/account/email/confirm", guard, auth, async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false, error: "Войдите в аккаунт" });
        if (!validCode(req.body?.code)) return res.status(400).json({ success: false, error: "Введите шестизначный код" });
        try {
            const result = await finish(supabase, req.user.id, "email_change", req.body.code);
            if (!result?.success) return res.status(400).json({ success: false, error: "Код недействителен, использован или срок действия истёк", reason: result?.reason });
            res.clearCookie("token", authCookie);
            disconnectUserSockets(req.user.id);
            return res.json({ success: true, reLogin: true });
        } catch (error) {
            console.error("[account/email/confirm]", error.message);
            return res.status(500).json({ success: false, error: "Не удалось изменить почту" });
        }
    });

    app.post("/auth/account/deletion/request", guard, auth, async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false, error: "Войдите в аккаунт" });
        try {
            const user = await getVerifiedUser(supabase, req.user.id, req.body?.password);
            if (!user) return res.status(403).json({ success: false, error: "Неверный пароль" });
            await makeAction(supabase, user, "delete", user.mail);
            return res.json({ success: true, email: user.mail, expiresInMinutes: 15 });
        } catch (error) {
            console.error("[account/deletion/request]", error.message);
            return res.status(error.status || 500).json({ success: false, error: error.status === 503 ? error.message : "Не удалось запросить удаление" });
        }
    });

    app.post("/auth/account/deletion/confirm", guard, auth, async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false, error: "Войдите в аккаунт" });
        if (!validCode(req.body?.code) || typeof req.body?.deleteMessages !== "boolean") {
            return res.status(400).json({ success: false, error: "Подтвердите удаление кодом и выбором данных" });
        }
        try {
            const result = await finish(supabase, req.user.id, "delete", req.body.code, req.body.deleteMessages);
            if (!result?.success) return res.status(400).json({ success: false, error: "Код недействителен, использован или срок действия истёк", reason: result?.reason });
            res.clearCookie("token", authCookie);
            disconnectUserSockets(req.user.id);
            return res.json({ success: true, deadline: result.deadline });
        } catch (error) {
            console.error("[account/deletion/confirm]", error.message);
            return res.status(500).json({ success: false, error: "Не удалось подтвердить удаление" });
        }
    });

    app.post("/auth/account/recover/request", guard, async (req, res) => {
        const email = emailValue(req.body?.email);
        if (!validEmail(email) || !validPassword(req.body?.password)) {
            return res.status(400).json({ success: false, error: "Некорректная почта или пароль" });
        }
        try {
            const { data: user, error } = await supabase.from("users")
                .select("id,mail,pass,deletion_requested_at").eq("mail", email).maybeSingle();
            if (error) throw error;
            if (!user?.deletion_requested_at ||
                Date.now() - new Date(user.deletion_requested_at).getTime() >= 30 * DAY ||
                !(await bcrypt.compare(req.body.password, user.pass))) {
                return res.status(403).json({ success: false, error: "Неверные данные или срок восстановления истёк" });
            }
            await makeAction(supabase, user, "recover", user.mail);
            return res.json({ success: true, expiresInMinutes: 15 });
        } catch (error) {
            console.error("[account/recover/request]", error.message);
            return res.status(error.status || 500).json({ success: false, error: error.status === 503 ? error.message : "Не удалось запросить восстановление" });
        }
    });

    app.post("/auth/account/recover/confirm", guard, async (req, res) => {
        const email = emailValue(req.body?.email);
        if (!validEmail(email) || !validPassword(req.body?.password) || !validCode(req.body?.code)) {
            return res.status(400).json({ success: false, error: "Некорректные данные" });
        }
        try {
            const { data: user, error } = await supabase.from("users")
                .select("id,mail,pass,deletion_requested_at").eq("mail", email).maybeSingle();
            if (error) throw error;
            if (!user?.deletion_requested_at ||
                !(await bcrypt.compare(req.body.password, user.pass))) {
                return res.status(403).json({ success: false, error: "Неверные данные" });
            }
            const result = await finish(supabase, user.id, "recover", req.body.code);
            if (!result?.success) return res.status(400).json({ success: false, error: "Код недействителен или срок восстановления истёк", reason: result?.reason });
            disconnectUserSockets(user.id);
            await issueSession(supabase, req, res, user.id, false);
            return res.json({ success: true });
        } catch (error) {
            console.error("[account/recover/confirm]", error.message);
            return res.status(500).json({ success: false, error: "Не удалось восстановить аккаунт" });
        }
    });
}
