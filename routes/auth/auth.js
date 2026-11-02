import bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import { sendMail } from "../../services/sendmail.js";
import dotenv from "dotenv";
import { randomInt } from "node:crypto";
import { issueSession } from "../../utils/authSession.js";
import { getMailTemplate } from "../../utils/mailTamlate.js";
dotenv.config();

const SECRET = process.env.JWT_SECRET;

export default function(app, supabase) {
  app.post("/auth", async (req, res) => {
    const { login, pass, isRemember } = req.body;
    if (!login || !pass) {
      return res.status(400).json({ success: false, error: "Все поля обязательны" });
    }

    try {
      const identity = typeof login === "string" ? login.trim() : "";
      if (identity.length > 254 || !identity || typeof pass !== "string" || pass.length > 256) {
        return res.status(400).json({ success: false, error: "Неверные данные входа" });
      }
      const { data: byEmail, error: emailError } = await supabase.from("users")
        .select("id, mail, nick, pass").eq("mail", identity.toLowerCase()).maybeSingle();
      if (emailError) throw emailError;
      let user = byEmail;
      if (!user) {
        const { data: byNick, error: nickError } = await supabase.from("users")
          .select("id, mail, nick, pass").eq("nick", identity).maybeSingle();
        if (nickError) throw nickError;
        user = byNick;
      }
      if (!user) return res.status(401).json({ success: false, error: "Неверный логин или пароль" });

      // 2️⃣ Проверяем пароль
      const valid = await bcrypt.compare(pass, user.pass);
      if (!valid) return res.status(401).json({ success: false, error: "Неверный логин или пароль" });

      // 3️⃣ Получаем настройки, чтобы проверить двухфакторку
      const { data: settings, error: settingsError } = await supabase
        .from("settings")
        .select("two_auth")
        .eq("user_id", user.id)
        .single();

      if (settingsError) {
        console.error("Ошибка получения настроек:", settingsError);
        return res.status(500).json({ success: false, error: "Ошибка сервера" });
      }

      // 4️⃣ Если 2FA включена — создаём токен и отправляем письмо
      if (settings.two_auth) {
        const code = String(randomInt(100000, 1000000));
        const createdAt = new Date().toISOString(); // Добавлено: created_at в UTC для timestamptz
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 10 минут

        const { error: insertTokenError } = await supabase
          .from("auth_tokens")
          .insert([{ mail: user.mail, code, created_at: createdAt, expires_at: expiresAt }]); // Добавлено created_at

        if (insertTokenError) {
          console.error("Ошибка сохранения токена:", insertTokenError);
          return res.status(500).json({ success: false, error: "Ошибка сервера" });
        }

      const mailHtml = getMailTemplate({
          code,
          title: "Подтвердите вход в аккаунт",
          subtitle: `Здравствуйте, ${user.nick}!`
      });

      await sendMail(
          user.mail,
          "Подтверждение входа",
          mailHtml
      );

        return res.status(200).json({
          success: true,
          message: "Письмо с подтверждением отправлено (2FA включена)",
          two_auth: settings.two_auth, // Добавлено для frontend
          email: user.mail,
        });
      }

      // 5️⃣ Если 2FA выключена — создаём JWT и авторизуем сразу
      await issueSession(supabase, req, res, user.id, !!isRemember);

      return res.status(200).json({
        success: true,
        message: "Вы успешно авторизованы",
        two_auth: settings.two_auth, // Добавлено для frontend
      });

    } catch (err) {
      console.error("Auth error:", err);
      return res.status(500).json({ success: false, error: err.message || "Ошибка сервера" });
    }
  });
}