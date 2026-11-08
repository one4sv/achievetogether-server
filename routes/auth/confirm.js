import { issueSession } from "../../utils/authSession.js";
import { createHmac } from "node:crypto";
import dotenv from "dotenv";
dotenv.config();

const attempts = new Map();

export default function (app, supabase) {
  app.post("/confirm", async (req, res) => {
    console.log("💡 POST /confirm called");
    const { code, email } = req.body;

    const cleanCode = typeof code === "string" ? code.trim() : "";
    const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!/^\\d{6}$/.test(cleanCode) || cleanEmail.length > 254 ||
      !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ success: false, error: "Некорректный код или email" });
    }

    // IP throttling supplements the database-level five-attempt token lock.
    const now = Date.now();
    const key = req.ip + ":" + cleanEmail;
    const state = attempts.get(key) || { count: 0, expires: now + 15 * 60000 };
    if (state.expires < now) { state.count = 0; state.expires = now + 15 * 60000; }
    state.count++;
    attempts.set(key, state);
    if (attempts.size > 15000) {
      for (const [id, value] of attempts) if (value.expires < now) attempts.delete(id);
    }
    if (state.count > 12) return res.status(429).json({
      success: false, error: "Слишком много попыток. Повторите позже."
    });

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
        await issueSession(supabase, req, res, newUser.id);

        return res.status(200).json({
          success: true,
          message: "Вы успешно зарегистрированы и авторизованы",
        });
      }

      // ═══════════════════════════════════════
      // 2. 2FA ВХОД (auth_tokens)
      // ═══════════════════════════════════════
      const { data: checked, error: checkError } = await supabase.rpc("at_consume_auth_login_code", {
        p_email: cleanEmail,
        p_code_hash: createHmac("sha256", process.env.JWT_SECRET).update(cleanCode).digest("hex")
      });
      if (checkError) throw checkError;

      if (checked?.reason === "deletion_pending") {
        return res.status(423).json({
          success: false, code: "DELETION_PENDING",
          email: cleanEmail, deadline: checked.deadline
        });
      }
      if (checked?.reason === "locked") {
        return res.status(429).json({ success: false, error: "Слишком много неверных кодов" });
      }
      if (checked?.success && checked.user_id) {
        await issueSession(supabase, req, res, checked.user_id);
        return res.status(200).json({
          success: true,
          message: "Вы успешно авторизованы"
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