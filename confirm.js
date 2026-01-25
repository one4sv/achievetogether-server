import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

const SECRET = process.env.JWT_SECRET;

export default function (app, supabase) {
  app.post("/confirm", async (req, res) => {
    console.log("💡 POST /confirm called");
    const { token } = req.body;
    if (!token) {
      console.log("❌ Токен не передан в теле запроса");
      return res.status(400).json({ success: false, error: "Токен обязателен" });
    }

    try {
      // 🔹 1. Проверяем pending_users (регистрация)
      const { data: pendingUser, error: pendingError } = await supabase
        .from("pending_users")
        .select("*")
        .eq("token", token)
        .single();

      if (pendingUser && !pendingError) {
        if (new Date(pendingUser.expires_at + ' GMT+0300').getTime() < Date.now()) {
          await supabase.from("pending_users").delete().eq("token", token);
          return res.status(404).json({ success: false, error: "Срок действия токена истёк" });
        }

        // Создаём пользователя
        const { error: insertError } = await supabase.from("users").insert({
          nick: pendingUser.nick,
          mail: pendingUser.mail,
          pass: pendingUser.pass,
        });
        if (insertError) throw insertError;

        const { data: newUser } = await supabase
          .from("users")
          .select("id")
          .eq("mail", pendingUser.mail)
          .single();

        // Настройки по умолчанию
        await supabase.from("settings").insert({
          user_id: newUser.id,
          order: ["everyday", "weekly", "sometimes"],
          private: {
            mail: "contacts",
            posts: "all",
            habits: "all",
            number: "contacts",
          },
          theme: "system",
          decor: "default",
          acsent: "poison",
          bg: "color",
          bg_url: null,
          two_auth: false,
          note: true,
          mess_note: true,
        });

        await supabase.from("pending_users").delete().eq("id", pendingUser.id);

        const jwtToken = jwt.sign({ id: newUser.id }, SECRET, { expiresIn: "30d" });
        res.cookie("token", jwtToken, { httpOnly: true, secure: true, sameSite: "none", maxAge: 30 * 24 * 60 * 60 * 1000 });

        return res.status(200).json({ success: true, message: "Вы успешно зарегистрированы и авторизованы" });
      }

      // 🔹 2. Проверяем pending_auth (2FA)
      const { data: pendingAuth, error: pendingAuthError } = await supabase
        .from("pending_auth")
        .select("mail, user_id, expires_at, change")
        .eq("token", token)
        .single();

      if (pendingAuth && !pendingAuthError) {
        const now = new Date(); // Текущее UTC время
        const expires = new Date(pendingAuth.expires_at + ' GMT+0300');
        if (expires < now) {
          await supabase.from("pending_auth").delete().eq("token", token);
          return res.status(404).json({ success: false, error: "Срок действия токена истёк" });
        }

        // Меняем состояние 2FA
        const { error: updateError } = await supabase
          .from("settings")
          .update({ two_auth: !pendingAuth.change })
          .eq("user_id", pendingAuth.user_id);

        if (updateError) throw updateError;

        await supabase.from("pending_auth").delete().eq("token", token);

        return res.status(200).json({ success: true, message: "Настройки 2FA успешно изменены" });
      }

      // 🔹 3. Проверяем auth_tokens (авторизация)
      const { data: authRow, error: authError } = await supabase
        .from("auth_tokens")
        .select("mail, expires_at")
        .eq("token", token)
        .single();

      if (authError || !authRow) {
        return res.status(404).json({ success: false, error: "Токен не найден" });
      }

      if (new Date(authRow.expires_at + ' GMT+0300').getTime() < Date.now()) {
        return res.status(404).json({ success: false, error: "Срок действия токена истёк" });
      }

      const { data: user } = await supabase
        .from("users")
        .select("id, nick, mail")
        .eq("mail", authRow.mail)
        .single();

      const jwtToken = jwt.sign({ id: user.id }, SECRET, { expiresIn: "30d" });
      res.cookie("token", jwtToken, { httpOnly: true, secure: true, sameSite: "none", maxAge: 30 * 24 * 60 * 60 * 1000 });

      await supabase.from("auth_tokens").delete().eq("token", token);

      return res.status(200).json({ success: true, message: "Вы успешно авторизованы" });
    } catch (err) {
      console.error("Ошибка при подтверждении:", err);
      return res.status(500).json({ success: false, error: "Внутренняя ошибка сервера" });
    }
  });

  app.get("/confirm", (req, res) => {
    res.send("Confirm endpoint is active");
  });
}