import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

const SECRET = process.env.JWT_SECRET;

export default function (app, supabase) {
  // Вход по нику (для админа)
  app.post("/admin", async (req, res) => {
    const { nick } = req.body;
    if (!nick) return res.status(400).json({ success: false, error: "Nick обязателен" });

    try {
      // Ищем пользователя
      const { data: user, error } = await supabase
        .from("users")
        .select("id, nick")
        .eq("nick", nick)
        .single();

      if (error || !user) {
        return res.status(404).json({ success: false, error: "Пользователь не найден" });
      }

      // Создаём JWT
      const token = jwt.sign({ id: user.id }, SECRET, { expiresIn: "30d" });

      // Отправляем куку
      res.cookie("token", token, {
        httpOnly: true,
        secure: false, // true если HTTPS
        sameSite: "lax",
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });

      return res.json({ success: true });
    } catch (err) {
      console.error("Ошибка при логине:", err);
      return res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}
