import { authenticateUser } from "./middleware/token.js";

export default function(app, supabase) {
  app.post("/updateuser", authenticateUser(supabase), async (req, res) => {
    const { id } = req.user;
    const payload = req.body; // expecting [{row: string, value: string}, ...]

    if (!Array.isArray(payload) || payload.length === 0) {
      return res.status(400).json({ success: false, error: "Empty payload" });
    }

    // whitelist of updatable columns
    const allowed = new Set(["username", "nick", "bio", "mail" /* avatar_url handled by /uploadavatar */ ]);

    const updateObj = {};
    for (const item of payload) {
      if (!item || typeof item.row !== "string") continue;
      const key = item.row;
      if (!allowed.has(key)) continue;
      updateObj[key] = item.value ?? null;
    }

    if (Object.keys(updateObj).length === 0) {
      return res.status(400).json({ success: false, error: "No valid fields to update" });
    }

    try {
      const { data, error } = await supabase
        .from("users")
        .update(updateObj)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        console.error("Supabase update error:", error);
        return res.status(500).json({ success: false, error: "Ошибка при обновлении пользователя" });
      }

      return res.json({ success: true, user: data });
    } catch (err) {
      console.error("Server error updateuser:", err);
      return res.status(500).json({ success: false, error: "Ошибка сервера" });
    }
  });
}