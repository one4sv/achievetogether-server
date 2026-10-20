export default function (app, supabase) {
    app.post("/ping", async (req, res) => {
    const { id } = req.body
    if (!id) return res.sendStatus(400)

    await supabase
        .from("users")
        .update({ last_online: new Date().toISOString() })
        .eq("id", id)

    res.sendStatus(200)
    })
}
