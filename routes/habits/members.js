import { authenticateUser } from "../../middleware/token.js";

export default function (app, supabase) {
    app.get("/habits/:id/members", authenticateUser(supabase), async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false });
        try {
            const { data: habit, error: habitError } = await supabase.from("habits")
                .select("id, user_id").eq("id", req.params.id).maybeSingle();
            if (habitError) throw habitError;
            if (!habit) return res.status(404).json({ success: false });
            const { data: membership, error: membershipError } = await supabase.from("habit_members")
                .select("status").eq("habit_id", habit.id).eq("user_id", req.user.id).maybeSingle();
            if (membershipError) throw membershipError;
            if (habit.user_id !== req.user.id && !membership) return res.status(403).json({ success: false });
            const { data: members, error } = await supabase.from("habit_members")
                .select("user_id, status, invited_by, created_at").eq("habit_id", habit.id);
            if (error) throw error;
            const userIds = [...new Set([habit.user_id, ...(members || []).map(member => member.user_id)])];
            const { data: users, error: usersError } = await supabase.from("users")
                .select("id, nick, username, avatar_url").in("id", userIds);
            if (usersError) throw usersError;
            res.json({ success: true, owner_id: habit.user_id, members: (members || []).map(member => ({
                ...member, user: users?.find(user => user.id === member.user_id) || null
            })) });
        } catch (error) {
            console.error("Ошибка получения участников:", error);
            res.status(500).json({ success: false });
        }
    });

    app.post("/habits/:id/members", authenticateUser(supabase), async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false });
        const userId = req.body?.user_id;
        const nick = req.body?.nick;
        if (typeof userId !== "string" && (typeof nick !== "string" || !nick.trim())) return res.status(400).json({ success: false });
        try {
            const { data: habit, error: habitError } = await supabase.from("habits")
                .select("id, user_id").eq("id", req.params.id).maybeSingle();
            if (habitError) throw habitError;
            if (!habit) return res.status(404).json({ success: false });
            if (habit.user_id !== req.user.id) return res.status(403).json({ success: false });
            const lookup = supabase.from("users").select("id");
            const { data: target, error: targetError } = await (typeof userId === "string"
                ? lookup.eq("id", userId) : lookup.eq("nick", nick.trim())).maybeSingle();
            if (target?.id === habit.user_id) return res.status(400).json({ success: false });
            if (targetError) throw targetError;
            if (!target) return res.status(404).json({ success: false });
            const { data: existing, error: existingError } = await supabase.from("habit_members")
                .select("status").eq("habit_id", habit.id).eq("user_id", target.id).maybeSingle();
            if (existingError) throw existingError;
            if (existing?.status === "accepted" || existing?.status === "pending") {
                return res.status(409).json({ success: false, error: "Already invited" });
            }
            const { error } = await supabase.from("habit_members").upsert({
                habit_id: habit.id, user_id: target.id, invited_by: req.user.id,
                status: "pending", updated_at: new Date().toISOString()
            }, { onConflict: "habit_id,user_id" });
            if (error) throw error;
            res.json({ success: true });
        } catch (error) {
            console.error("Ошибка приглашения участника:", error);
            res.status(500).json({ success: false });
        }
    });

    app.patch("/habits/:id/members/me", authenticateUser(supabase), async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false });
        const status = req.body?.status;
        if (!["accepted", "declined"].includes(status)) return res.status(400).json({ success: false });
        try {
            const { data: member, error: findError } = await supabase.from("habit_members")
                .select("status").eq("habit_id", req.params.id).eq("user_id", req.user.id).maybeSingle();
            if (findError) throw findError;
            if (!member || member.status !== "pending") return res.status(409).json({ success: false });
            const { error } = await supabase.from("habit_members").update({
                status, updated_at: new Date().toISOString()
            }).eq("habit_id", req.params.id).eq("user_id", req.user.id).eq("status", "pending");
            if (error) throw error;
            res.json({ success: true });
        } catch (error) {
            console.error("Ошибка ответа на приглашение:", error);
            res.status(500).json({ success: false });
        }
    });

    app.delete("/habits/:id/members/:userId", authenticateUser(supabase), async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false });
        try {
            const { data: habit, error: habitError } = await supabase.from("habits")
                .select("user_id").eq("id", req.params.id).maybeSingle();
            if (habitError) throw habitError;
            if (!habit) return res.status(404).json({ success: false });
            if (habit.user_id !== req.user.id && req.params.userId !== req.user.id) {
                return res.status(403).json({ success: false });
            }
            const { error } = await supabase.from("habit_members").delete()
                .eq("habit_id", req.params.id).eq("user_id", req.params.userId);
            if (error) throw error;
            res.json({ success: true });
        } catch (error) {
            console.error("Ошибка удаления участника:", error);
            res.status(500).json({ success: false });
        }
    });
}
