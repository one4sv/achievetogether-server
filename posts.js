export default function (app, supabase) {
    app.get("/posts/:id", async (req, res) => {
        try {
            const { id } = req.params;

            const { data, error } = await supabase
            .from("posts")
            .select("*")
            .eq("user_id", id)
            .order("created_at", { ascending: false });

            if (error) throw error;

            return res.json({ success: true, posts: data });
        } catch (e) {
            console.error("Ошибка при получении постов:", e);
            return res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });
}
