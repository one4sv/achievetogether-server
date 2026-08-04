import { authenticateUser } from "./middleware/token.js";

export default function(app, supabase) {
    app.get("/user", authenticateUser(supabase), async (req, res) => {
        const id = req.user?.id;

        if (!id) {
            return res.status(401).json({
                success: false,
                error: "Не авторизован"
            });
        }

        try {
            const { data, error } = await supabase
                .from("users")
                .select("*")
                .eq("id", id)
                .maybeSingle();

            if (error || !data) {
                return res.status(404).json({
                    success: false,
                    error: "Пользователь не найден"
                });
            }

            res.json({
                success: true,
                nick: data.nick,
                mail: data.mail,
                username: data.username,
                bio: data.bio,
                avatar_url: data.avatar_url,
                last_online: data.last_online,
                reg_date:data.registration_date,
                date_of_birth:data.date_of_birth,
                sex:data.sex,
                id
            });

        } catch (err) {
            console.error("Ошибка запроса к Supabase:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });
}