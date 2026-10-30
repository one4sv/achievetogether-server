import { authenticateUser } from "../../middleware/token.js"

export default function (app, supabase) {
    app.post('/updatesettings', authenticateUser(supabase), async (req, res) => {
        const setting = Object.keys(req.body)[0];
        const value = req.body[setting];

        const id = req.user?.id;
        if (!id) return res.status(401).json({ error: 'User not authenticated' });

        try {
            if (setting === "group_invites") {
                const modes = ["direct", "message", "none"];
                if (!value || typeof value !== "object" || !modes.includes(value.contacts) || !modes.includes(value.others)) {
                    return res.status(400).json({ success: false, error: "Некорректные правила приглашений" });
                }
                const { error } = await supabase.from("settings").upsert({
                    user_id: id,
                    group_invite_contacts: value.contacts,
                    group_invite_others: value.others,
                }, { onConflict: "user_id" });
                if (error) throw error;
                return res.json({ success: true });
            }
            if (['order', 'show_archived', 'show_archived_in_acc', 'private', "week_start"].includes(setting)) {
                const { error } = await supabase
                    .from('settings')
                    .upsert({
                        user_id: id,
                        [setting]: value,
                    }, { onConflict: ['user_id'] });
                if (error) throw error;

                return res.status(200).json({ success: true });
            } else {
                return res.status(400).json({ error: 'Invalid setting type' });
            }
        } catch (err) {
            console.error('Ошибка при обновлении:', err);
            return res.status(500).json({ error: 'Ошибка сервера' });
        }
    });
}
