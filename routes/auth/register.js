import bcrypt from "bcrypt";
import { randomInt } from "node:crypto";
import { sendMail } from "../../services/sendmail.js"; // твой модуль с API
import dotenv from "dotenv";
import { getMailTemplate } from "../../utils/mailTamlate.js";

dotenv.config();

export default function(app, supabase) {
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
                await sendMail(mail, "Подтверждение регистрации", mailHtml);
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
