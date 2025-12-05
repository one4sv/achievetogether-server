import bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import { sendMail } from "./sendmail.js"; // твой модуль с API
import dotenv from "dotenv";
import jwt from "jsonwebtoken";

dotenv.config();

const SECRET = process.env.JWT_SECRET;

export default function(app, supabase) {
  app.post("/auth", async (req, res) => {
    const { login, pass } = req.body;
    if (!login || !pass) {
      return res.status(400).json({ success: false, error: "Все поля обязательны" });
    }

    try {
      const { data: users, error: fetchError } = await supabase
        .from("users")
        .select("id, mail, nick, pass")
        .or(`mail.eq.${login},nick.eq.${login}`)
        .limit(1);

      if (fetchError || !users || users.length === 0) {
        return res.status(401).json({ success: false, error: "Неверный логин или пароль" });
      }

      const user = users[0];

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
        const token = randomUUID();
        const createdAt = new Date().toISOString(); // Добавлено: created_at в UTC для timestamptz
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 минут

        const { error: insertTokenError } = await supabase
          .from("auth_tokens")
          .insert([{ mail: user.mail, token, created_at: createdAt, expires_at: expiresAt }]); // Добавлено created_at

        if (insertTokenError) {
          console.error("Ошибка сохранения токена:", insertTokenError);
          return res.status(500).json({ success: false, error: "Ошибка сервера" });
        }

      const link = `${process.env.CLIENT_URL}/confirm?token=${token}`;
      const mailHtml = `
        <h2>Привет, ${user.nick}!</h2>
        <p>Для завершения авторизации нажми на ссылку ниже:</p>
        <a href="${link}">Подтвердить авторизацию</a>
        <p>Если авторизовывались не вы — смените пароль.</p>
      `;

      // Отправка через SendGrid
      await sendMail(user.mail, "Подтверждение авторизации", mailHtml);

        return res.status(200).json({
          success: true,
          message: "Письмо с подтверждением отправлено (2FA включена)",
          two_auth: settings.two_auth, // Добавлено для frontend
        });
      }

      // 5️⃣ Если 2FA выключена — создаём JWT и авторизуем сразу
      const jwtToken = jwt.sign({ id: user.id }, SECRET, { expiresIn: "30d" });
      res.cookie("token", jwtToken, { httpOnly: true, secure: true, sameSite: "none", maxAge: 30 * 24 * 60 * 60 * 1000 });

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