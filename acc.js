import { authenticateUser } from "./middleware/token.js";

export default function(app, supabase) {
    app.get("/acc", (req, res) => {
        res.send("acc api is working")
    })
    app.get("/acc/:id", async (req, res) => {
        try {
            const { id } = req.params;

            const { data:acc, error:accError } = await supabase
                .from("users")
                .select("*")
                .eq("id", id)
                .single()
            if (accError) {
                console.log(accError)
                throw accError
            }

            const { data:habits, error:habitsError } = await supabase
                .from("habits")
                .select("*")
                .eq("user_id", id)
            if (habitsError) {
                console.log(habitsError)
                throw habitsError
            }

            const { data: settings, error: privateError } = await supabase
                .from("settings")
                .select("private")
                .eq("user_id", id)
                .single()
            if (privateError) {
                console.log(privateError)
                throw privateError
            }

            return res.json({
                success:true,
                acc, 
                habits, 
                privateRules:settings?.private || {}
            })
        } catch (err) {
            console.log(err)
            res.status(500).json({ success: false, error: "Server error" });
        }
    })
}