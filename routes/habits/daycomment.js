import { authenticateUser } from "../../middleware/token.js";
import { requireHabitPermission } from "../../utils/habitAccess.js";
import { isCalendarDate } from "../../utils/validation.js";
import { broadcastHabitCommentUpdated } from "../../realtime/ws.js";

export default function (app, supabase) {
    app.get("/habits/:id/day-comments", authenticateUser(supabase), requireHabitPermission(supabase, "view"), async (req, res) => {
        const date = req.query.date || new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" });
        if (!isCalendarDate(date)) return res.status(400).json({ success: false, error: "Некорректная дата" });
        try {
            const { data: comments, error } = await supabase.from("completions_comments")
                .select("id, user_id, comment, date, created_at").eq("habit_id", req.params.id)
                .eq("date", date).order("created_at", { ascending: true });
            if (error) throw error;
            // A completion belongs to the progress owner in shared mode,
            // but the person who pressed Done is recorded separately.
            const { data: completions, error: completionsError } = await supabase
                .from("habit_completions")
                .select("id, user_id, actor_user_id, completed_at, created_at")
                .eq("habit_id", req.params.id)
                .eq("completed_at", date)
                .eq("is_user_marked", true)
                .order("created_at", { ascending: false });
            if (completionsError) throw completionsError;
            const shared = req.habitAccess.habit.metric_progress_mode === "shared";
            const completed = (completions || []).map(item => ({
                id: item.id,
                user_id: item.actor_user_id || (shared ? null : item.user_id),
                created_at: item.created_at
            }));
            const { data: scheduleActions, error: scheduleActionsError } = await supabase
                .from("schedule_completions")
                .select("id, schedule_id, user_id, actor_user_id, created_at")
                .eq("habit_id", req.params.id).eq("date", date);
            if (scheduleActionsError) throw scheduleActionsError;
            const scheduleIds = [...new Set((scheduleActions || []).map(item => item.schedule_id))];
            const { data: taskNames, error: taskNamesError } = scheduleIds.length
                ? await supabase.from("schedule").select("id, name").in("id", scheduleIds)
                : { data: [], error: null };
            if (taskNamesError) throw taskNamesError;
            const taskActions = (scheduleActions || []).map(item => ({
                id: item.id,
                created_at: item.created_at,
                user_id: item.actor_user_id || (shared ? null : item.user_id),
                name: (taskNames || []).find(task => task.id === item.schedule_id)?.name || "Задача"
            }));
            const ids = [...new Set([
                ...(comments || []).map(item => item.user_id),
                ...completed.map(item => item.user_id),
                ...taskActions.map(item => item.user_id)
            ].filter(Boolean))];
            const { data: users, error: usersError } = ids.length ? await supabase.from("users")
                .select("id, nick, username, avatar_url").in("id", ids) : { data: [], error: null };
            if (usersError) throw usersError;
            res.json({
                success: true,
                comments: (comments || []).filter(item => item.comment?.trim()).map(item => ({
                    ...item, user: users.find(user => user.id === item.user_id) || null
                })),
                completions: completed.map(item => ({
                    ...item,
                    user: users.find(user => user.id === item.user_id) || null
                })),
                taskCompletions: taskActions.map(item => ({
                    ...item,
                    user: users.find(user => user.id === item.user_id) || null
                }))
            });
        } catch (error) {
            console.error("Ошибка комментариев активности:", error);
            res.status(500).json({ success: false, error: "Не удалось загрузить комментарии" });
        }
    });

    app.post("/daycomment", authenticateUser(supabase), requireHabitPermission(supabase, "comment"), async (req, res) => {
        const { habit_id, text, date } = req.body;
        const targetDate = date || new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" });
        if (typeof text !== "string" || text.length > 200 || !isCalendarDate(targetDate)) {
            return res.status(400).json({ success: false, error: "Проверьте текст и дату комментария" });
        }
        try {
            const { error } = await supabase.rpc("save_habit_day_comment", {
                p_actor: req.user.id, p_habit: Number(habit_id), p_date: targetDate, p_text: text
            });
            if (error) throw error;
            void broadcastHabitCommentUpdated(supabase, habit_id, targetDate);
            res.json({ success: true });
        } catch (error) {
            console.error("Ошибка сохранения комментария:", error);
            res.status(error.code === "42501" ? 403 : 500).json({ success: false, error: "Не удалось сохранить комментарий" });
        }
    });
}
