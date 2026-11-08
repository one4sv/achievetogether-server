import { authenticateUser } from "../../middleware/token.js";

const validTime = value => typeof value === "string" && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
const offsets = { start: 0, "10start": 10, "60start": 60, end: 0, "10end": 10, "60end": 60 };
const validCodes = new Set([...Object.keys(offsets), "inpstart", "inpend", "inp"]);

const allowedOrigin = origin => {
    const valid = (process.env.CLIENT_URL || "https://achievetogether.vercel.app")
        .split(",").map(item => item.trim());
    if (process.env.NODE_ENV !== "production") valid.push("http://localhost:5173", "http://127.0.0.1:5173");
    return valid.includes(origin);
};

export default function habitReminderRoutes(app, supabase) {
    const auth = authenticateUser(supabase);
    const protect = (req, res, next) => {
        res.set("Cache-Control", "no-store");
        if (!req.user?.id) return res.status(401).json({ success: false, error: "Войдите в аккаунт" });
        if (!allowedOrigin(req.get("origin"))) return res.status(403).json({ success: false, error: "Недопустимый источник" });
        next();
    };

    app.get("/settings/reminders", auth, async (req, res) => {
        res.set("Cache-Control", "no-store");
        if (!req.user?.id) return res.status(401).json({ success: false, error: "Войдите в аккаунт" });
        try {
            const [prefs, rules] = await Promise.all([
                supabase.from("at_habit_reminder_preferences").select("*").eq("user_id", req.user.id).maybeSingle(),
                supabase.from("at_habit_reminder_rules").select("habit_id,code,minutes_before,fixed_time")
                    .eq("user_id", req.user.id).order("habit_id")
            ]);
            if (prefs.error) throw prefs.error;
            if (rules.error) throw rules.error;
            return res.json({
                success: true,
                preferences: {
                    enabled: prefs.data?.enabled ?? false,
                    commonEnabled: prefs.data?.common_enabled ?? true,
                    commonTime: (prefs.data?.common_time || "18:00").slice(0, 5),
                    timezone: prefs.data?.timezone || "UTC"
                },
                rules: rules.data || []
            });
        } catch (error) {
            console.error("[reminder-settings/get]", error.message);
            return res.status(500).json({ success: false, error: "Не удалось загрузить напоминания" });
        }
    });

    app.post("/settings/reminders/preferences", auth, protect, async (req, res) => {
        const { enabled, commonEnabled, commonTime, timezone } = req.body || {};
        if (typeof enabled !== "boolean" || typeof commonEnabled !== "boolean" ||
            !validTime(commonTime) || typeof timezone !== "string" ||
            timezone.length > 100 || !timezone) {
            return res.status(400).json({ success: false, error: "Некорректные настройки напоминаний" });
        }
        try {
            new Intl.DateTimeFormat("en-US", { timeZone: timezone });
        } catch {
            return res.status(400).json({ success: false, error: "Неверный часовой пояс" });
        }
        try {
            const { data, error } = await supabase.from("at_habit_reminder_preferences").upsert({
                user_id: req.user.id,
                enabled,
                common_enabled: commonEnabled,
                common_time: commonTime,
                timezone,
                updated_at: new Date().toISOString()
            }, { onConflict: "user_id" }).select("enabled,common_enabled,common_time,timezone").single();
            if (error) throw error;
            return res.json({
                success: true,
                preferences: { enabled: data.enabled, commonEnabled: data.common_enabled,
                    commonTime: data.common_time.slice(0, 5), timezone: data.timezone }
            });
        } catch (error) {
            console.error("[reminder-settings/update]", error.message);
            return res.status(500).json({ success: false, error: "Не удалось сохранить настройки" });
        }
    });

    app.post("/settings/reminders/habit", auth, protect, async (req, res) => {
        const { habitId, rules } = req.body || {};
        if (!Number.isSafeInteger(habitId) || habitId <= 0 ||
            !Array.isArray(rules) || rules.length > 9) {
            return res.status(400).json({ success: false, error: "Некорректный список напоминаний" });
        }
        const used = new Set();
        const cleaned = [];
        for (const rule of rules) {
            if (!rule || typeof rule !== "object" || !validCodes.has(rule.code) || used.has(rule.code)) {
                return res.status(400).json({ success: false, error: "Неверное правило напоминания" });
            }
            used.add(rule.code);
            const before = rule.code === "inpstart" || rule.code === "inpend" ?
                Number(rule.minutes_before) : offsets[rule.code] ?? 0;
            if (!Number.isSafeInteger(before) || before < 0 || before > 1440 ||
                ((rule.code === "inpstart" || rule.code === "inpend") && before < 1)) {
                return res.status(400).json({ success: false, error: "Неверное время до активности" });
            }
            const fixedTime = rule.code === "inp" ? rule.fixed_time : null;
            if (rule.code === "inp" && !validTime(fixedTime)) {
                return res.status(400).json({ success: false, error: "Неверный формат времени" });
            }
            cleaned.push({ code: rule.code, minutes_before: before, fixed_time: fixedTime });
        }
        try {
            const { data, error } = await supabase.rpc("at_replace_habit_reminder_rules", {
                p_user_id: req.user.id,
                p_habit_id: habitId,
                p_rules: cleaned
            });
            if (error) throw error;
            if (data !== true) return res.status(403).json({ success: false, error: "Нет доступа к активности" });
            return res.json({ success: true, habitId, rules: cleaned });
        } catch (error) {
            console.error("[reminder-settings/habit]", error.message);
            return res.status(500).json({ success: false, error: "Не удалось сохранить напоминания" });
        }
    });
}
