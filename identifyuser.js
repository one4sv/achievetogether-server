import { authenticateUser } from "./middleware/token.js"

export default function(app, supabase) {
    app.get("/identifyuser/:id", authenticateUser(supabase), async (req, res) => {
    const userId = req.params.id;

    try {
        const { data: user, error } = await supabase
            .from("users")
            .select("id, username, nick, avatar_url")
            .eq("id", userId)
            .single();

        if (error || !user) {
            return res.status(404).json({ success: false, error: "Пользователь не найден" });
        }

        res.json({
            success: true,
            name: user.username,
            nick: user.nick,
            avatar_url: user.avatar_url
        });
    } catch (err) {
        console.error("Ошибка в /infouser/:id:", err);
        res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
    })
}