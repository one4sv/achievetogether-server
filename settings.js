import { authenticateUser } from "./middleware/token.js"

export default function(app, supabase) {
    app.get("/settings", authenticateUser(supabase), async (req, res) => {
        const { id } = req.user;

        try {
            const { data, error } = await supabase
                .from("settings")
                .select("*")
                .eq("user_id", id)
                .limit(1)
                .maybeSingle();

            if (error || !data) {
                console.log(error)
                return res.status(404).json({ success: false, error: "Настройки не найдены" });
            }

            res.json({
                success: true,
                order: data.order,
                amountHabits:data.amountHabits,
                theme:data.theme,
                private:data.private,
                acsent:data.acsent,
                bg:data.bg,
                decor:data.decor,
                bg_url:data.bg_url,
            });
        } catch (err) {
            console.error("Ошибка запроса к Supabase:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });
}
