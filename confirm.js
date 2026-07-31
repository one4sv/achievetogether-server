import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

const SECRET = process.env.JWT_SECRET;

export default function (app, supabase) {
  app.post("/confirm", async (req, res) => {
    console.log("💡 POST /confirm called");
    const { code, email } = req.body;

    if (!code || !email) {
      return res.status(400).json({
        success: false,
        error: "Код и email обязательны",
      });
    }

    const cleanCode = String(code).trim();
    const cleanEmail = String(email).trim().toLowerCase();

    try {
      // ═══════════════════════════════════════
      // 1. РЕГИСТРАЦИЯ (pending_users)
      // ═══════════════════════════════════════
      const { data: pendingUser, error: pendingError } = await supabase
        .from("pending_users")
        .select("*")
        .eq("mail", cleanEmail)
        .eq("code", cleanCode)
        .maybeSingle();

      if (pendingUser && !pendingError) {
        // Проверка срока действия
        if (new Date(pendingUser.expires_at).getTime() < Date.now()) {
          await supabase.from("pending_users").delete().eq("id", pendingUser.id);
          return res.status(410).json({
            success: false,
            error: "Срок действия кода истёк",
          });
        }

        // Создаём пользователя
        const { data: newUser, error: insertError } = await supabase
          .from("users")
          .insert({
            nick: pendingUser.nick,
            mail: pendingUser.mail,
            pass: pendingUser.pass,
          })
          .select("id")
          .single();

        if (insertError) throw insertError;

        // Функция для week_start
        function getDefaultWeekStart() {
          const today = new Date();
          const year = today.getFullYear();
          const sept1ThisYear = new Date(year, 8, 1); // сентябрь

          if (today >= sept1ThisYear) {
            return sept1ThisYear;
          }
          return new Date(year - 1, 8, 1);
        }

        // Настройки по умолчанию
        const { data, error: createError } = await supabase
          .from("settings").insert({
            user_id: newUser.id,
            order: ["everyday", "weekly", "sometimes"],
            week_start: getDefaultWeekStart().toISOString().split("T")[0],
            private: {
              mail: "contacts",
              posts: "all",
              habits: "all",
              number: "contacts",
            },
            bg_url: null,
            two_auth: false,
          });
          if (createError) {
            console.error("Не удалось создать настройки:", createError);
            console.error("Детали:", JSON.stringify(createError, null, 2));
            return res.status(500).json({ success: false, error: "Ошибка сервера" });
          }

        // Удаляем из pending
        await supabase.from("pending_users").delete().eq("id", pendingUser.id);

        // JWT + cookie
        const jwtToken = jwt.sign({ id: newUser.id }, SECRET, {
          expiresIn: "30d",
        });

        res.cookie("token", jwtToken, {
          httpOnly: true,
          secure: true,
          sameSite: "none",
          maxAge: 30 * 24 * 60 * 60 * 1000,
        });

        return res.status(200).json({
          success: true,
          message: "Вы успешно зарегистрированы и авторизованы",
        });
      }

      // ═══════════════════════════════════════
      // 2. 2FA ВХОД (auth_tokens)
      // ═══════════════════════════════════════
      const { data: authRow, error: authError } = await supabase
        .from("auth_tokens")
        .select("*")
        .eq("mail", cleanEmail)
        .eq("code", cleanCode)
        .maybeSingle();

      if (authRow && !authError) {
        if (new Date(authRow.expires_at).getTime() < Date.now()) {
          await supabase.from("auth_tokens").delete().eq("id", authRow.id);
          return res.status(410).json({
            success: false,
            error: "Срок действия кода истёк",
          });
        }

        // Находим пользователя
        const { data: user, error: userError } = await supabase
          .from("users")
          .select("id")
          .eq("mail", authRow.mail)
          .single();

        if (userError || !user) {
          return res.status(404).json({
            success: false,
            error: "Пользователь не найден",
          });
        }

        // JWT + cookie
        const jwtToken = jwt.sign({ id: user.id }, SECRET, {
          expiresIn: "30d",
        });

        res.cookie("token", jwtToken, {
          httpOnly: true,
          secure: true,
          sameSite: "none",
          maxAge: 30 * 24 * 60 * 60 * 1000,
        });

        // Удаляем использованный код
        await supabase.from("auth_tokens").delete().eq("id", authRow.id);

        return res.status(200).json({
          success: true,
          message: "Вы успешно авторизованы",
        });
      }

      // Ничего не нашли
      return res.status(404).json({
        success: false,
        error: "Неверный код или email",
      });
    } catch (err) {
      console.error("Ошибка при подтверждении:", err);
      return res.status(500).json({
        success: false,
        error: "Внутренняя ошибка сервера",
      });
    }
  });

  app.get("/confirm", (req, res) => {
    res.send("Confirm endpoint is active");
  });
}