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
    console.log("🔑 Получен токен:", token);

    try {
      console.log("⏳ Проверяем pending_users...");
      let { data: pendingUser, error: pendingError } = await supabase
        .from("pending_users")
        .select("*")
        .eq("token", token)
        .single();
      
      console.log("pendingUser:", pendingUser, "pendingError:", pendingError);

      if (pendingError || !pendingUser) {
        console.log("⚡ Токен не найден в pending_users, ищем в auth_tokens...");
        const { data: authRow, error: authError } = await supabase
          .from("auth_tokens")
          .select("mail, expires_at")
          .eq("token", token)
          .single();
        console.log("authRow:", authRow, "authError:", authError);

        if (authError || !authRow) {
          console.log("❌ Токен не найден в auth_tokens");
          return res.status(404).json({ success: false, error: "Токен не найден", reason: "expired" });
        }

        if (new Date(authRow.expires_at).getTime() < Date.now()) {
          console.log("⏰ Токен истёк");
          return res.status(404).json({ success: false, error: "Срок действия токена истёк", reason: "expired" });
        }

        console.log("✅ Токен действителен, ищем пользователя по почте...");
        const { data: user, error: userError } = await supabase
          .from("users")
          .select("id, nick, mail")
          .eq("mail", authRow.mail)
          .single();
        console.log("user:", user, "userError:", userError);

        if (userError || !user) {
          console.log("❌ Пользователь не найден");
          return res.status(404).json({ success: false, error: "Пользователь не найден" });
        }

        const jwtToken = jwt.sign({ id: user.id }, SECRET, { expiresIn: "30d" });
        console.log("🔑 Сгенерирован JWT для существующего пользователя:", jwtToken);

        res.cookie("token", jwtToken, { httpOnly: true, secure: true, sameSite: "none", maxAge: 30*24*60*60*1000 });
        console.log("🍪 Cookie установлена:", res.getHeader("Set-Cookie"));

        await supabase.from("auth_tokens").delete().eq("token", token);
        console.log("🗑️ Токен удалён из auth_tokens");

        return res.status(200).json({ success: true, message: "Вы успешно авторизованы" });
      }

      // --- Если нашли в pending_users ---
      console.log("✅ Токен найден в pending_users:", pendingUser);
      if (new Date(pendingUser.expires_at).getTime() < Date.now()) {
        console.log("⏰ Токен в pending_users истёк");
        return res.status(404).json({ success: false, error: "Срок действия токена истёк", reason: "expired" });
      }

      console.log("📝 Вставляем нового пользователя в users...");
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
      console.log("newUser:", newUser);

      // --- Вставка настроек ---
      console.log("⚙️ Вставляем настройки пользователя...");
      const defaultPrivate = {
        mail: "contacts",
        posts: "all",
        habits: "all",
        number: "contacts"
      };
      await supabase.from("settings").insert({
        user_id: newUser.id,
        order: JSON.stringify(["everyday", "weekly", "sometimes"]),
        amountHabits: JSON.stringify([5,5,5,5,5]),
        private: JSON.stringify(defaultPrivate),
        theme: "system",
        decor: "default",
        acsent: "poison",
        bg: "default",
        bg_url: null
      });
      console.log("✅ Настройки вставлены");

      // Удаляем pending
      await supabase.from("pending_users").delete().eq("id", pendingUser.id);
      console.log("🗑️ Пользователь удалён из pending_users");

      // JWT
      const jwtToken = jwt.sign({ id: newUser.id }, SECRET, { expiresIn: "30d" });
      console.log("🔑 JWT для нового пользователя:", jwtToken);

      res.setHeader("Access-Control-Allow-Origin", process.env.CLIENT_URL);
      res.setHeader("Access-Control-Allow-Credentials", "true");

      res.cookie("token", jwtToken, { httpOnly: true, secure: true, sameSite: "none", maxAge: 30*24*60*60*1000 });
      console.log("🍪 Cookie установлена:", res.getHeader("Set-Cookie"));

      return res.status(200).json({ success: true, message: "Вы успешно зарегистрированы и авторизованы" });

    } catch (err) {
      console.log("❌ Ошибка внутри try/catch");
      console.error("Ошибка при подтверждении:", err);
      return res.status(500).json({ success: false, error: "Внутренняя ошибка сервера" });
    }
  });

  app.get('/confirm', (req, res) => {
    res.send('Confirm AT server is running');
  });
}
