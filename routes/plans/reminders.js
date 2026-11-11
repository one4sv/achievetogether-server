import { authenticateUser } from "../../middleware/token.js";

export function validPlanReminderOffsets(value) {
    return Array.isArray(value) && value.length <= 8 &&
        new Set(value).size === value.length &&
        value.every(offset => Number.isSafeInteger(offset) && offset >= 1 && offset <= 10080);
}

const allowedOrigin = origin => {
    const urls = (process.env.CLIENT_URL || "https://achievetogether.vercel.app")
        .split(",").map(item => item.trim());
    if (process.env.NODE_ENV !== "production") urls.push("http://localhost:5173", "http://127.0.0.1:5173");
    return urls.includes(origin);
};

export default function planReminderRoutes(app, supabase) {
    const auth = authenticateUser(supabase);
    const guard = (req, res, next) => {
        res.set("Cache-Control", "no-store");
        if (!req.user?.id) return res.status(401).json({ success: false, error: "Требуется авторизация" });
        if (!allowedOrigin(req.get("origin"))) return res.status(403).json({ success: false, error: "Недопустимый источник" });
        next();
    };

    async function planAccess(planId, userId) {
        if (!/^[1-9]\d*$/.test(String(planId)) || !Number.isSafeInteger(Number(planId))) return false;
        const { data: plan, error } = await supabase.from("one_off_plans")
            .select("id,owner_id").eq("id", planId).maybeSingle();
        if (error) throw error;
        if (!plan) return false;
        if (plan.owner_id === userId) return true;
        const { data: member, error: memberError } = await supabase.from("one_off_plan_members")
            .select("status").eq("plan_id", planId).eq("user_id", userId).maybeSingle();
        if (memberError) throw memberError;
        return member?.status === "accepted";
    }

    app.get("/settings/plan-reminders", auth, async (req, res) => {
        res.set("Cache-Control", "no-store");
        if (!req.user?.id) return res.status(401).json({ success: false });
        try {
            const { data, error } = await supabase.from("at_plan_reminder_preferences")
                .select("enabled,default_minutes_before").eq("user_id", req.user.id).maybeSingle();
            if (error) throw error;
            return res.json({ success: true, preferences: {
                enabled: data?.enabled ?? false,
                defaultMinutesBefore: data?.default_minutes_before ?? 60
            } });
        } catch (error) {
            console.error("[plan-reminders/get]", error.message);
            return res.status(500).json({ success: false, error: "Не удалось получить настройки" });
        }
    });

    app.post("/settings/plan-reminders", auth, guard, async (req, res) => {
        const { enabled, defaultMinutesBefore } = req.body || {};
        if (typeof enabled !== "boolean" || !Number.isSafeInteger(defaultMinutesBefore) ||
            defaultMinutesBefore < 0 || defaultMinutesBefore > 10080) {
            return res.status(400).json({ success: false, error: "Некорректное время напоминания" });
        }
        try {
            const { data, error } = await supabase.from("at_plan_reminder_preferences")
                .upsert({ user_id: req.user.id, enabled, default_minutes_before: defaultMinutesBefore,
                    updated_at: new Date().toISOString() }, { onConflict: "user_id" })
                .select("enabled,default_minutes_before").single();
            if (error) throw error;
            return res.json({ success: true, preferences: {
                enabled: data.enabled, defaultMinutesBefore: data.default_minutes_before
            } });
        } catch (error) {
            console.error("[plan-reminders/prefs]", error.message);
            return res.status(500).json({ success: false, error: "Не удалось сохранить настройки" });
        }
    });

    app.get("/plans/:id/reminders", auth, async (req, res) => {
        res.set("Cache-Control", "no-store");
        if (!req.user?.id) return res.status(401).json({ success: false });
        try {
            if (!await planAccess(req.params.id, req.user.id))
                return res.status(404).json({ success: false, error: "План не найден" });
            const { data, error } = await supabase.from("at_plan_reminder_rules")
                .select("minutes_before").eq("user_id", req.user.id)
                .eq("plan_id", req.params.id).order("minutes_before");
            if (error) throw error;
            return res.json({ success: true, rules: (data || []).map(row => row.minutes_before) });
        } catch (error) {
            console.error("[plan-reminders/list]", error.message);
            return res.status(500).json({ success: false, error: "Не удалось загрузить напоминания" });
        }
    });

    app.post("/plans/:id/reminders", auth, guard, async (req, res) => {
        const rules = req.body?.rules;
        if (!validPlanReminderOffsets(rules)) {
            return res.status(400).json({ success: false, error: "Некорректные напоминания" });
        }
        try {
            const { data, error } = await supabase.rpc("at_replace_plan_reminder_rules", {
                p_user_id: req.user.id,
                p_plan_id: Number(req.params.id),
                p_offsets: rules
            });
            if (error) throw error;
            if (data !== true) return res.status(404).json({ success: false, error: "План не найден" });
            return res.json({ success: true, rules });
        } catch (error) {
            console.error("[plan-reminders/update]", error.message);
            return res.status(500).json({ success: false, error: "Не удалось сохранить напоминания" });
        }
    });
}
