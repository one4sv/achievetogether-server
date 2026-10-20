import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import registerRoutes from "./routes/index.js";

export default function createApp(supabase) {
    const app = express();
    app.disable("x-powered-by");
    app.use(cors({
        origin: process.env.CLIENT_URL || "https://achievetogether.vercel.app",
        credentials: true
    }));
    app.use(express.json());
    app.use(cookieParser());
    app.get("/", (req, res) => res.send("Backend AT server is running"));
    registerRoutes(app, supabase);
    app.use((req, res) => res.status(404).json({ success: false, error: "Маршрут не найден" }));
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        const status = error.code === "LIMIT_FILE_SIZE" ? 413 : Number(error.status || error.statusCode) || 500;
        const safeStatus = status >= 400 && status <= 599 ? status : 500;
        const message = safeStatus === 413 ? "Файл слишком большой" : safeStatus === 400 ? "Некорректный запрос" : "Ошибка сервера";
        res.status(safeStatus).json({ success: false, error: message });
    });
    return app;
}
