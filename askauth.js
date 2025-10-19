import { sendMail } from "./sendmail.js";
import { randomUUID } from "crypto";
import { authenticateUser } from "./middleware/token.js";
import dotenv from "dotenv";
dotenv.config();

export default function (app, supabase) {
    app.post("/askauth", authenticateUser(supabase), async (req, res) => {
        const { id } = req.user;

        try {
            const { data: user, error: userError } = await supabase
                .from("users")
                .select("mail")
                .eq("id", id)
                .single();

            if (userError || !user) {
                console.error("Ошибка получения пользователя:", userError);
                return res.status(500).json({ success: false, error: "Ошибка сервера" });
            }

            const { data: settings, error: settingsError } = await supabase
                .from("settings")
                .select("two_auth")
                .eq("user_id", id)
                .single();

            if (settingsError) throw settingsError;

            const nowIso = new Date().toISOString(); // Текущее UTC в ISO

            const { data: existing } = await supabase
                .from("pending_auth")
                .select("id")
                .eq("user_id", id)
                .gt("expires_at", nowIso)
                .limit(1);

            console.log("Existing pending_auth:", existing);
            if (existing && existing.length > 0) {
                return res.status(200).json({ success: true, message: "Письмо уже отправлено" });
            }

            const token = randomUUID();
            const expires = new Date(Date.now() + 10 * 60 * 1000); // +10 минут от текущего UTC
            const expiresIso = expires.toISOString();

            await supabase.from("pending_auth").insert({
                mail: user.mail,
                user_id: id,
                token,
                expires_at: expiresIso,
                change: settings.two_auth
            });

            const action = settings.two_auth ? "отключение" : "включение";
            const confirmLink = `${process.env.CLIENT_URL}/confirm?token=${token}`;

            const mailHtml = `
                <p>Вы запросили ${action} двухфакторной аутентификации.</p>
                <p>Чтобы подтвердить, перейдите по ссылке:</p>
                <a href="${confirmLink}">${confirmLink}</a>
            `;

            await sendMail(user.mail, `Подтверждение ${action} 2FA`, mailHtml);

            return res.json({ success: true, message: "Письмо отправлено" });

        } catch (err) {
            console.error("Ошибка /askauth:", err);
            return res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });

    app.get("/askauth", authenticateUser(supabase), async (req, res) => {
        try {
            const { id } = req.user;

            const { data: user, error: userError } = await supabase
                .from("users")
                .select("mail")
                .eq("id", id)
                .single();

            if (userError || !user) {
                console.error("Ошибка получения пользователя:", userError);
                return res.status(500).json({ success: false, error: "Ошибка сервера" });
            }

            const nowIso = new Date().toISOString();

            const { data: pending, error: pendingError } = await supabase
                .from("pending_auth")
                .select("id, expires_at, change")
                .eq("mail", user.mail)
                .gt("expires_at", nowIso)
                .limit(1)
                .single();

            if (pendingError && pendingError.code !== "PGRST116") {
                console.error("Ошибка при проверке pending_auth:", pendingError);
                return res.status(500).json({ success: false, error: "Ошибка сервера" });
            }

            if (!pending) {
                return res.status(200).json({ success: true, isAsked: false });
            }

            return res.status(200).json({
                success: true,
                isAsked: true,
                expires_at: pending.expires_at,
                change: pending.change
            });
        } catch (err) {
            console.error("Ошибка в /askauth:", err);
            return res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });
}