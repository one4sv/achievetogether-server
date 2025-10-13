import jwt from "jsonwebtoken";

export function authenticateUser(supabase) {
  return async function (req, res, next) {
    const token = req.cookies.token;

    if (!token) {
      return res.status(401).json({ success: false, error: "Токен не найден в куках" });
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
      next();
    } catch (err) {
      console.log("Ошибка верификации токена:", err);
      return res.status(403).json({ success: false, error: "Недействительный токен" });
    }
  };
}
