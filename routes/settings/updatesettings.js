import { authenticateUser } from "../../middleware/token.js"

export default function (app, supabase) {
    app.post('/updatesettings', authenticateUser(supabase), async (req, res) => {
        const setting = Object.keys(req.body)[0];
        const value = req.body[setting];

        const id = req.user?.id;
        if (!id) return res.status(401).json({ error: 'User not authenticated' });

        try {
            if (setting === "bg_effects") {
                const filters = ["none", "grayscale", "sepia", "invert", "contrast", "saturate"];
                if (!value || typeof value !== "object" || Array.isArray(value) ||
                    !Number.isFinite(value.blur) || value.blur < 0 || value.blur > 30 ||
                    typeof value.movement !== "boolean" || !filters.includes(value.filter)) {
                    return res.status(400).json({ success: false, error: "Некорректные параметры фона" });
                }
                const effects = { blur: Math.round(value.blur), movement: value.movement, filter: value.filter };
                const { error } = await supabase.from("settings").upsert({
                    user_id: id,
                    bg_effects: effects
                }, { onConflict: "user_id" });
                if (error) throw error;
                return res.json({ success: true, bg_effects: effects });
            }
            if (setting === "quick_actions") {
                const types = new Set(["feed", "settings", "profile", "habits", "habit", "chat"]);
                if (!Array.isArray(value) || value.length > 3) {
                    return res.status(400).json({ success: false, error: "Максимум три быстрых действия" });
                }

                const ids = new Set();
                const safe = [];

                for (const action of value) {
                    if (!action || typeof action !== "object" || Array.isArray(action) ||
                        !types.has(action.type)) {
                        return res.status(400).json({ success: false, error: "Неверное быстрое действие" });
                    }
                    const dynamic = action.type === "habit" || action.type === "chat";
                    const target = typeof action.target === "string" ? action.target : "";
                    const label = typeof action.label === "string" ? action.label.trim() : "";
                    if (dynamic && (!target || target.length > 120 || label.length > 80 ||
                        !(action.type === "habit"
                            ? /^[1-9][0-9]{0,11}$/.test(target)
                            : /^(?:g\/)?[\p{L}\p{N}_-]{1,100}$/u.test(target)))) {
                        return res.status(400).json({ success: false, error: "Некорректный адрес быстрого действия" });
                    }
                    const key = action.type + ":" + (dynamic ? target : "");
                    if (ids.has(key)) return res.status(400).json({ success: false, error: "Повторяющееся быстрое действие" });
                    ids.add(key);
                    safe.push(dynamic ? { type: action.type, target, label } : { type: action.type });
                }

                const { error } = await supabase.from("settings").upsert({
                    user_id: id,
                    quick_actions: safe
                }, { onConflict: "user_id" });
                if (error) throw error;
                return res.json({ success: true, quick_actions: safe });
            }

            if (setting === "chat_welcome") {
                if (!value || typeof value !== "object" || Array.isArray(value) ||
                    typeof value.enabled !== "boolean" || typeof value.text !== "string" ||
                    value.text.length > 500 || (value.enabled && !value.text.trim())) {
                    return res.status(400).json({ success: false, error: "Некорректное приветственное сообщение" });
                }
                const { error } = await supabase.from("settings").upsert({
                    user_id: id,
                    chat_welcome: { enabled: value.enabled, text: value.text.trim() },
                }, { onConflict: "user_id" });
                if (error) throw error;
                return res.json({ success: true });
            }
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
