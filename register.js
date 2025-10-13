import bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

export default function(app, supabase) {
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
            const checkDuplicates = async (table) => {
                const { data: byNick, error: errNick } = await supabase
                    .from(table)
                    .select("nick")
                    .eq("nick", nick)
                    .limit(1);
                if (errNick) throw errNick;
                if (byNick?.length > 0) return { field: "nick" };

                const { data: byMail, error: errMail } = await supabase
                    .from(table)
                    .select("mail")
                    .eq("mail", mail)
                    .limit(1);
                if (errMail) throw errMail;
                if (byMail?.length > 0) return { field: "mail" };

                return null;
            };

            const dupeInUsers = await checkDuplicates("users");
            if (dupeInUsers) {
                return res.status(409).json({
                    success: false,
                    error: dupeInUsers.field === "nick"
                        ? "Этот ник уже занят"
                        : "Эта почта уже зарегистрирована"
                });
            }

            const dupeInPending = await checkDuplicates("pending_users");
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
            const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
            });

            const mailOptions = {
            from: `"AchieveTogether" <${process.env.EMAIL_USER}>`,
            to: mail,
            subject: "Подтверждение регистрации",
            html: `
                <h2>Привет, ${nick}!</h2>
                <p>Для завершения регистрации нажми на ссылку ниже:</p>
                <a href="${link}">Подтвердить аккаунт</a>
                <p>Если это были не вы — просто проигнорируйте это письмо.</p>
            `
            };
            try {
                await transporter.sendMail(mailOptions);
                console.log("Mail has been sent", mail);
            } catch (mailError) {
                console.error("Error mail send:", mailError);
                return res.status(500).json({ success: false, error: "Ошибка отправки письма" });
            }
            res.status(200).json({
                success: true,
                message: "Письмо с подтверждением отправлено"
            });
        } catch (err) {
            console.error("Registration exception:", err);
            res.status(500).json({
                success: false,
                error: err.message || "Ошибка регистрации"
            });
        }
    });
}
