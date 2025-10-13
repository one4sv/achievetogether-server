import bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

export default function(app, supabase) {
  app.post("/auth", async (req, res) => {
    const { login, pass } = req.body;
    if (!login || !pass) {
      return res.status(400).json({ success: false, error: "Все поля обязательны" });
    }

    try {
      const { data: users, error: fetchError } = await supabase
        .from("users")
        .select("mail, nick, pass")
        .or(`mail.eq.${login},nick.eq.${login}`)
        .limit(1);

      if (fetchError || !users || users.length === 0) {
        return res.status(401).json({ success: false, error: "Неверный логин или пароль" });
      }

      const user = users[0];
      const valid = await bcrypt.compare(pass, user.pass);

      if (!valid) {
        return res.status(401).json({ success: false, error: "Неверный логин или пароль" });
      }

      // Проверяем, есть ли в auth_tokens неистёкший токен для этого пользователя
      const now = new Date().toISOString();
      const { data: existingTokens, error: tokenFetchError } = await supabase
        .from("auth_tokens")
        .select("token, expires_at")
        .eq("mail", user.mail)
        .gt("expires_at", now)
        .limit(1);

      if (tokenFetchError) {
        console.error("Ошибка получения токена:", tokenFetchError);
        return res.status(500).json({ success: false, error: "Ошибка сервера" });
      }

      let token;
      if (existingTokens && existingTokens.length > 0) {
        // Есть действующий токен — переиспользуем его
        token = existingTokens[0].token;
      } else {
        // Создаём новый токен
        token = randomUUID();
        const expiresAt = new Date(Date.now() + 24*60*60*1000).toISOString();

        const { error: insertTokenError } = await supabase
          .from("auth_tokens")
          .insert([{ mail: user.mail, token, expires_at: expiresAt }]);

        if (insertTokenError) {
          console.error("Ошибка сохранения токена:", insertTokenError);
          return res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
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
        to: user.mail,
        subject: "Подтверждение авторизации",
        html: `
          <h2>Привет, ${user.nick}!</h2>
          <p>Для завершения авторизации нажми на ссылку ниже:</p>
          <a href="${link}">Подтвердить авторизацию</a>
          <p>Если авторизовывались не вы — смените пароль.</p>
        `
      };

      try {
        await transporter.sendMail(mailOptions);
        console.log("Mail has been sent", user.mail);
      } catch (mailError) {
        console.error("Ошибка отправки письма:", mailError);
        return res.status(500).json({ success: false, error: "Ошибка отправки письма" });
      }

      res.status(200).json({
        success: true,
        message: "Письмо с подтверждением отправлено"
      });

    } catch (err) {
      res.status(500).json({ success: false, error: err.message || "Ошибка сервера" });
    }
  });
}
