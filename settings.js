import { authenticateUser } from "./middleware/token.js";

// ==================== ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ С RETRY ====================
const withRetry = async (operation, maxRetries = 4) => {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (err) {
            lastError = err;

            const isNetworkError =
                err.message?.includes("fetch failed") ||
                err.cause?.message?.includes("fetch") ||
                err.name === "TypeError" ||
                err.code === "ECONNRESET" ||
                err.code === "ENOTFOUND";

            if (!isNetworkError || attempt === maxRetries) {
                console.error(`❌ Supabase запрос окончательно провалился после ${attempt + 1} попыток:`, err);
                throw err;
            }

            const delay = Math.min(800 * Math.pow(2, attempt), 8000);
            console.warn(`⚠️ [RETRY] Supabase (${attempt + 1}/${maxRetries + 1}) — повтор через ${delay}мс: ${err.message}`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastError;
};
// ========================================================================

export default function (app, supabase) {
    app.get("/settings", authenticateUser(supabase), async (req, res) => {
        const { id } = req.user;

        try {
            const { data, error } = await withRetry(() =>
                supabase
                    .from("settings")
                    .select("*")
                    .eq("user_id", id)
                    .limit(1)
                    .maybeSingle()
            );

            if (error || !data) {
                console.error("Ошибка получения настроек:", error);
                return res.status(404).json({ success: false, error: "Настройки не найдены" });
            }

            res.json({
                success: true,
                order: data.order,
                theme: data.theme,
                private: data.private,
                acsent: data.acsent,
                bg: data.bg,
                decor: data.decor,
                bg_url: data.bg_url,
                twoAuth: data.two_auth,
                all_note: data.all_note,
                new_mess_note: data.new_mess_note,
                show_archived: data.show_archived,
                show_archived_in_acc: data.show_archived_in_acc,
                week_start: data.week_start
            });
        } catch (err) {
            console.error("Ошибка запроса к Supabase (/settings):", err);
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: "Ошибка сервера" });
            }
        }
    });
}