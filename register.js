import bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import { sendMail } from "./sendmail.js"; // твой модуль с API
import dotenv from "dotenv";
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
        const { nick, mail, pass } = req.body;
        console.log("Register data:", { nick, mail, pass });

        if (!nick || !mail || !pass) {
            return res.status(400).json({ success: false, error: "Все поля обязательны" });
        }

        try {
            const dupeInUsers = await checkDuplicates("users", nick, mail);
            if (dupeInUsers) {
                return res.status(409).json({
                    success: false,
                    error: dupeInUsers.field === "nick"
                        ? "Этот ник уже занят"
                        : "Эта почта уже зарегистрирована"
                });
            }

            const dupeInPending = await checkDuplicates("pending_users", nick, mail);
            if (dupeInPending) {
                return res.status(409).json({
                    success: false,
                    error: dupeInPending.field === "nick"
                        ? "Этот ник уже ожидает подтверждения"
                        : "Эта почта уже ожидает подтверждения"
                });
            }

            const hashedPassword = await bcrypt.hash(pass, 10);
            const token = randomUUID();
            const created_at = new Date().toISOString();
            const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

            const { error: insertError } = await supabase
                .from("pending_users")
                .insert([{ nick, mail, pass: hashedPassword, token, created_at, expires_at }]);

            if (insertError) {
                console.error("Ошибка добавления в PendingUsers:", insertError);
                return res.status(500).json({ success: false, error: "Ошибка регистрации" });
            }
            const link = `${process.env.CLIENT_URL}/confirm?token=${token}`;
            const html = `
                <h2>Привет, ${nick}!</h2>
                <p>Для завершения регистрации нажми на ссылку ниже:</p>
                <a href="${link}">Подтвердить аккаунт</a>
                <p>Если это были не вы — просто проигнорируйте это письмо.</p>
            `;

            await sendMail(mail, "Подтверждение регистрации", html);

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
