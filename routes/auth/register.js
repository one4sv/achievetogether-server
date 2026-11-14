import bcrypt from "bcrypt";
import { randomInt } from "node:crypto";
import { sendMail } from "../../services/sendmail.js"; // твой модуль с API
import dotenv from "dotenv";
import { getMailTemplate } from "../../utils/mailTamlate.js";

dotenv.config();

export default function(app, supabase, { send: sendRegistrationMail = sendMail } = {}) {
    const checkDuplicates = async (table, nick, mail) => {
        if (nick) {
            const { data, error } = await supabase
                .from(table)
                .select("id")
                .eq("nick", nick)
                .limit(1);

            if (error) throw error;
            if (data.length) return { field: "nick" };
        }

        if (mail) {
            const { data, error } = await supabase
                .from(table)
                .select("id")
                .eq("mail", mail)
                .limit(1);

            if (error) throw error;
            if (data.length) return { field: "mail" };
        }

        return null;
    };
    app.get('/register', (req, res) => {
        res.send("Принимаем...");
    });

    app.post("/register", async (req, res) => {
        const { nick, mail, pass } = req.body || {};


        if (typeof nick !== "string" || !/^[A-Za-z0-9_]{4,16}$/.test(nick) ||
            typeof mail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail.trim()) ||
            typeof pass !== "string" || pass.length < 8 || pass.length > 30 ||
            !/^[A-Za-z0-9]+$/.test(pass) || !/[A-Za-z]/.test(pass) || !/\d/.test(pass)) {
            return res.status(400).json({ success: false, error: "Некорректные данные регистрации" });
        }

        try {
            const dupeInUsers = await checkDuplicates("users", nick, mail.trim().toLowerCase());
            if (dupeInUsers) {
                return res.status(409).json({
                    success: false,
                    error: dupeInUsers.field === "nick"
                        ? "Этот ник уже занят"
                        : "Эта почта уже зарегистрирована"
                });
            }

            const dupeInPending = await checkDuplicates("pending_users", nick, mail.trim().toLowerCase());
            if (dupeInPending) {
                return res.status(409).json({
                    success: false,
                    error: dupeInPending.field === "nick"
                        ? "Этот ник уже ожидает подтверждения"
                        : "Эта почта уже ожидает подтверждения"
                });
            }

            const hashedPassword = await bcrypt.hash(pass, 10);
            const code = String(randomInt(100000, 1000000));
            const created_at = new Date().toISOString();
            const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

            const { error: insertError } = await supabase
                .from("pending_users")
                .insert([{ nick, mail: mail.trim().toLowerCase(), pass: hashedPassword, code, created_at, expires_at }]);

            if (insertError) {
                console.error("Ошибка добавления в PendingUsers:", insertError);
                return res.status(500).json({ success: false, error: "Ошибка регистрации" });
            }
            const mailHtml = getMailTemplate({
                code,
                title: "Подтвердите регистрацию",
                subtitle: `Здравствуйте, ${nick}!`,
                expireText: "Код действителен 24 часа"
            });

            try {
                await sendRegistrationMail(mail, "Подтверждение регистрации", mailHtml);
            } catch (deliveryError) {
                await supabase.from("pending_users").delete().eq("mail", mail).eq("nick", nick).eq("code", code);
                throw deliveryError;
            }

            res.status(200).json({ success: true, message: "Письмо с подтверждением отправлено" });

        } catch (err) {
            console.error("Registration error:", err);
            res.status(500).json({ success: false, error: err.message || "Ошибка регистрации" });
        }
    });

    app.post("/register/resend", async (req, res) => {
        const mail = typeof req.body?.mail === "string" ? req.body.mail.trim().toLowerCase() : "";
        if (mail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
            return res.status(400).json({ success: false, error: "Некорректный email" });
        }

        try {
            const { data: pending, error: pendingError } = await supabase
                .from("pending_users")
                .select("id, nick, mail, code, created_at, expires_at")
                .eq("mail", mail)
                .maybeSingle();
            if (pendingError) throw pendingError;
            if (!pending) return res.status(404).json({
                success: false, error: "Ожидающая подтверждения регистрация не найдена"
            });

            const now = Date.now();
            const remaining = Math.ceil((60000 - (now - new Date(pending.created_at).getTime())) / 1000);
            if (remaining > 0) {
                res.set("Retry-After", String(remaining));
                return res.status(429).json({
                    success: false, error: "Повторная отправка пока недоступна",
                    retryAfterSeconds: remaining
                });
            }

            let code = String(randomInt(100000, 1000000));
            while (code === pending.code) code = String(randomInt(100000, 1000000));
            const created_at = new Date(now).toISOString();
            const expires_at = new Date(now + 24 * 60 * 60 * 1000).toISOString();

            // Database-side conditional update prevents simultaneous requests from bypassing the cooldown.
            const { data: updated, error: updateError } = await supabase
                .from("pending_users")
                .update({ code, created_at, expires_at })
                .eq("id", pending.id)
                .lte("created_at", new Date(now - 60000).toISOString())
                .select("id")
                .maybeSingle();
            if (updateError) throw updateError;
            if (!updated) {
                res.set("Retry-After", "60");
                return res.status(429).json({
                    success: false, error: "Повторная отправка пока недоступна",
                    retryAfterSeconds: 60
                });
            }

            try {
                await sendRegistrationMail(mail, "Подтверждение регистрации", getMailTemplate({
                    code,
                    title: "Подтвердите регистрацию",
                    subtitle: `Здравствуйте, ${pending.nick}!`,
                    expireText: "Код действителен 24 часа"
                }));
            } catch (deliveryError) {
                // Keep the previous usable code when the mail provider rejects a resend.
                const { error: rollbackError } = await supabase.from("pending_users")
                    .update({ code: pending.code, created_at: pending.created_at, expires_at: pending.expires_at })
                    .eq("id", pending.id)
                    .eq("code", code);
                if (rollbackError) console.error("Registration resend rollback error:", rollbackError);
                throw deliveryError;
            }

            return res.json({ success: true, retryAfterSeconds: 60 });
        } catch (error) {
            console.error("Registration resend error:", error);
            return res.status(500).json({ success: false, error: "Не удалось повторно отправить код" });
        }
    });

    app.post("/register/check", async (req, res) => {
        const { nick, mail } = req.body;

        try {
            let result = await checkDuplicates("users", nick, mail);
            if (!result) {
                result = await checkDuplicates("pending_users", nick, mail);
            }

            if (result) {
                return res.json({
                    success: false,
                    field: result.field,
                });
            }

            res.json({
                success: true,
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({
                success: false,
                error: err.message,
            });
        }
    });
}
