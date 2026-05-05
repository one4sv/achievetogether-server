import jwt from "jsonwebtoken";

export function authenticateUser(supabase) {
  return async function (req, res, next) {
    const token = req.cookies.token;

    if (!token) {
      req.user = null;
      return next();
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
    } catch (err) {
      console.log("Ошибка верификации токена:", err);
      req.user = null; // 👈 тоже гость
    }
    next();
  };
}