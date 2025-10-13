import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

const SECRET = process.env.JWT_SECRET;

export default function (app, supabase) {
  app.post("/confirm", async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, error: "Токен обязателен" });

    try {
      // --- Проверяем регистрацию ---
      let { data: pendingUser, error: pendingError } = await supabase
        .from("pending_users")
        .select("*")
        .eq("token", token)
        .single();

      if (pendingError || !pendingUser) {
        // --- Если нет в pending_users, ищем авторизацию ---
        const { data: authRow, error: authError } = await supabase
          .from("auth_tokens")
          .select("mail, expires_at")
          .eq("token", token)
          .single();

        if (authError || !authRow) {
          return res.status(404).json({ success: false, error: "Токен не найден", reason: "expired" });
        }

        if (new Date(authRow.expires_at).getTime() < Date.now()) {
          return res.status(404).json({ success: false, error: "Срок действия токена истёк", reason: "expired" });
        }

        const { data: user, error: userError } = await supabase
          .from("users")
          .select("id, nick, mail")
          .eq("mail", authRow.mail)
          .single();

        if (userError || !user) return res.status(404).json({ success: false, error: "Пользователь не найден" });

        const jwtToken = jwt.sign({ id: user.id }, SECRET, { expiresIn: "30d" });

        res.cookie("token", jwtToken, { httpOnly: true, secure: false, sameSite: "lax", maxAge: 30*24*60*60*1000 });

        await supabase.from("auth_tokens").delete().eq("token", token);

        return res.status(200).json({ success: true, message: "Вы успешно авторизованы" });
      }

      // --- Если нашли в pending_users ---
      if (new Date(pendingUser.expires_at).getTime() < Date.now()) {
        return res.status(404).json({ success: false, error: "Срок действия токена истёк", reason: "expired" });
      }

      // Вставляем в users
      const { error: insertError } = await supabase.from("users").insert({
        nick: pendingUser.nick,
        mail: pendingUser.mail,
        pass: pendingUser.pass
      });

      if (insertError) throw insertError;

      const { data: newUser } = await supabase
        .from("users")
        .select("id")
        .eq("mail", pendingUser.mail)
        .single();

      // --- Вставка настроек ---
      const defaultPrivate = {
        mail: "contacts",
        posts: "all",
        habits: "all",
        number: "contacts"
      };

      await supabase.from("settings").insert({
        user_id: newUser.id,
        order: JSON.stringify(["everyday", "weekly", "sometimes"]),
        amountHabits: JSON.stringify([5,5,5,5,5]), // или любое значение по умолчанию
        private: JSON.stringify(defaultPrivate),
        theme: "system",
        decor: "default",
        acsent: "poison",
        bg: "default",
        bg_url: null
      });

      // Удаляем pending
      await supabase.from("pending_users").delete().eq("id", pendingUser.id);

      // JWT
      const jwtToken = jwt.sign({ id: newUser.id }, SECRET, { expiresIn: "30d" });
      res.cookie("token", jwtToken, { httpOnly: true, secure: true, sameSite: "none", maxAge: 30*24*60*60*1000 });
      console.log(res.getHeader("Set-Cookie"));
      console.log("Sending cookie:", jwtToken);
      return res.status(200).json({ success: true, message: "Вы успешно зарегистрированы и авторизованы" });

    } catch (err) {
      console.error("Ошибка при подтверждении:", err);
      return res.status(500).json({ success: false, error: "Внутренняя ошибка сервера" });
    }
  });
}
