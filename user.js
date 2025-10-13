import { authenticateUser } from "./middleware/token.js"

export default function(app, supabase) {
    app.get("/user", authenticateUser(supabase), async (req, res) => {
        const { id } = req.user;

        try {
            const { data, error } = await supabase
                .from("users")
                .select("*")
                .eq("id", id)
                .limit(1)
                .single();

            if (error || !data) {
                return res.status(404).json({ success: false, error: "Пользователь не найден" });
            }

             res.json({
                success: true,
                nick: data.nick,
                mail: data.mail,
                username: data.username,
                bio: data.bio,
                avatar_url: data.avatar_url,
                last_online:data.last_online,
                id: id 
            });
        } catch (err) {
            console.error("Ошибка запроса к Supabase:", err);
            res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });
}
