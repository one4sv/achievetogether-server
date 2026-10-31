import { authenticateUser } from "../../middleware/token.js";

export default function (app, supabase) {
    app.get("/habits/:id/activity", authenticateUser(supabase), async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false });
        try {
            const { data: habit, error: habitError } = await supabase.from("habits")
                .select("id, user_id").eq("id", req.params.id).maybeSingle();
            if (habitError) throw habitError;
            if (!habit) return res.status(404).json({ success: false });
            if (habit.user_id !== req.user.id) {
                const { data: member, error: memberError } = await supabase.from("habit_members")
                    .select("status").eq("habit_id", habit.id).eq("user_id", req.user.id)
                    .eq("status", "accepted").maybeSingle();
                if (memberError) throw memberError;
                if (!member) return res.status(403).json({ success: false });
            }
            const { data: members, error: membershipsError } = await supabase.from("habit_members")
                .select("user_id, status, created_at").eq("habit_id", habit.id);
            if (membershipsError) throw membershipsError;
            const userIds = [...new Set([habit.user_id, ...(members || []).filter(m => m.status === "accepted").map(m => m.user_id)])];
            const { data: completions, error: completionError } = await supabase.from("habit_completions")
                .select("id, user_id, completed_at, created_at").eq("habit_id", habit.id)
                .in("user_id", userIds).order("created_at", { ascending: false }).limit(150);
            if (completionError) throw completionError;
            const { data: auditEvents, error: auditError } = await supabase.from("habit_activity_events")
                .select("id, user_id, type, details, created_at").eq("habit_id", habit.id)
                .order("created_at", { ascending: false }).limit(150);
            if (auditError) throw auditError;
            for (const item of auditEvents || []) if (item.user_id && !userIds.includes(item.user_id)) userIds.push(item.user_id);
            const { data: users, error: usersError } = await supabase.from("users")
                .select("id, nick, username, avatar_url").in("id", userIds);
            if (usersError) throw usersError;
            const byId = new Map((users || []).map(user => [user.id, user]));
            const events = [
                ...(completions || []).map(item => ({
                    id: `completion-${item.id}`, type: "completion", user_id: item.user_id,
                    user: byId.get(item.user_id) || null, date: item.completed_at,
                    created_at: item.created_at
                })),
                ...(auditEvents || []).map(item => ({
                    id: `audit-${item.id}`, type: item.type, user_id: item.user_id,
                    user: byId.get(item.user_id) || null, created_at: item.created_at,
                    date: item.details?.date || null
                }))
            ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0,150);
            res.json({ success: true, events });
        } catch (error) {
            console.error("Ошибка журнала участников:", error);
            res.status(500).json({ success: false, error: "Не удалось загрузить журнал" });
        }
    });

    app.patch("/habits/:id/collaboration", authenticateUser(supabase), async (req, res) => {
        const allowed = {
            metric_progress_mode: ["personal", "shared"],
            schedule_blocks_mode: ["personal", "shared"],
            members_can_edit_blocks: [true, false],
            members_can_edit_info: [true, false],
            members_can_invite: [true, false]
        };
        const changes = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => Object.hasOwn(allowed, key)));
        if (!Object.keys(changes).length || Object.entries(changes).some(([key, value]) => !allowed[key].includes(value))) {
            return res.status(400).json({ success: false, error: "Некорректные настройки совместной активности" });
        }
        try {
            const { data: habit, error: habitError } = await supabase.from("habits")
                .select("id, user_id").eq("id", req.params.id).maybeSingle();
            if (habitError) throw habitError;
            if (!habit) return res.status(404).json({ success: false });
            if (habit.user_id !== req.user?.id) return res.status(403).json({ success: false, error: "Нет прав изменять настройки" });
            const { data, error } = await supabase.from("habits").update(changes)
                .eq("id", habit.id).eq("user_id", req.user.id).select("*").single();
            if (error) throw error;
            return res.json({ success: true, habit: data });
        } catch (error) {
            console.error("Ошибка настроек совместной активности:", error);
            return res.status(500).json({ success: false, error: "Не удалось сохранить настройки" });
        }
    });

    app.patch("/habits/:id/chat-mode", authenticateUser(supabase), async (req, res) => {
        const mode = req.body?.mode;
        if (!["required", "optional"].includes(mode)) return res.status(400).json({ success: false });
        try {
            const { data: habit, error: findError } = await supabase.from("habits")
                .select("id, user_id, chat_id").eq("id", req.params.id).maybeSingle();
            if (findError) throw findError;
            if (!habit) return res.status(404).json({ success: false });
            if (habit.user_id !== req.user?.id) return res.status(403).json({ success: false });
            if (!habit.chat_id) return res.status(409).json({ success: false, error: "Сначала привяжите беседу" });
            const { error } = await supabase.from("habits").update({ chat_participation_mode: mode })
                .eq("id", habit.id).eq("user_id", req.user.id);
            if (error) throw error;
            return res.json({ success: true, mode });
        } catch (error) {
            console.error("Ошибка режима совместной активности:", error);
            return res.status(500).json({ success: false });
        }
    });

    app.patch("/habits/:id/chat", authenticateUser(supabase), async (req, res) => {
        const userId = req.user?.id;
        const chatId = req.body?.chat_id;
        if (!userId) return res.status(401).json({ success: false });
        if (chatId !== null && (!Number.isSafeInteger(chatId) || chatId <= 0)) {
            return res.status(400).json({ success: false, error: "Некорректная беседа" });
        }
        try {
            const { data: habit, error: habitError } = await supabase.from("habits")
                .select("id, user_id, chat_id").eq("id", req.params.id).maybeSingle();
            if (habitError) throw habitError;
            if (!habit) return res.status(404).json({ success: false });
            if (habit.user_id !== userId) return res.status(403).json({ success: false, error: "Только владелец может изменять привязку" });
            if (chatId !== null) {
                const { data: chat, error: chatError } = await supabase.from("chats")
                    .select("id, is_group").eq("id", chatId).maybeSingle();
                if (chatError) throw chatError;
                if (!chat || !chat.is_group) return res.status(400).json({ success: false, error: "Выберите беседу" });
                const { data: member, error: memberError } = await supabase.from("chat_members")
                    .select("id").eq("chat_id", chatId).eq("user_id", userId).maybeSingle();
                if (memberError) throw memberError;
                if (!member) return res.status(403).json({ success: false, error: "Вы не участник этой беседы" });
            }
            const { data: updated, error } = await supabase.from("habits")
                .update({ chat_id: chatId }).eq("id", habit.id).eq("user_id", userId)
                .select("id, chat_id").single();
            if (error) throw error;
            return res.json({ success: true, habit: updated });
        } catch (error) {
            console.error("Ошибка привязки активности к беседе:", error);
            return res.status(500).json({ success: false, error: "Не удалось изменить привязку" });
        }
    });

    app.post("/habits/:id/join-chat", authenticateUser(supabase), async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false });
        try {
            const { data: habit, error: habitError } = await supabase.from("habits")
                .select("id, user_id, chat_id, chat_participation_mode")
                .eq("id", req.params.id).maybeSingle();
            if (habitError) throw habitError;
            if (!habit || !habit.chat_id) return res.status(404).json({ success: false });
            const { data: inChat, error: chatError } = await supabase.from("chat_members")
                .select("id").eq("chat_id", habit.chat_id).eq("user_id", req.user.id).maybeSingle();
            if (chatError) throw chatError;
            if (!inChat) return res.status(403).json({ success: false, error: "Вы не участник беседы" });
            if (habit.user_id === req.user.id) return res.json({ success: true });
            const { data: existing, error: existingError } = await supabase.from("habit_members")
                .select("status").eq("habit_id", habit.id).eq("user_id", req.user.id).maybeSingle();
            if (existingError) throw existingError;
            if (existing?.status === "accepted") return res.json({ success: true });
            const { error } = await supabase.from("habit_members").upsert({
                habit_id: habit.id, user_id: req.user.id, invited_by: habit.user_id,
                status: "accepted", updated_at: new Date().toISOString()
            }, { onConflict: "habit_id,user_id" });
            if (error) throw error;
            return res.json({ success: true });
        } catch (error) {
            console.error("Ошибка присоединения к активности беседы:", error);
            return res.status(500).json({ success: false });
        }
    });

    app.get("/habits/invitations", authenticateUser(supabase), async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false });
        try {
            const { data: invitations, error } = await supabase.from("habit_members")
                .select("habit_id, status, invited_by, created_at")
                .eq("user_id", req.user.id).in("status", ["pending", "accepted"]);
            if (error) throw error;
            const habitIds = (invitations || []).map(item => item.habit_id);
            if (!habitIds.length) return res.json({ success: true, invitations: [] });
            const { data: habits, error: habitsError } = await supabase.from("habits")
                .select("id, name, user_id").in("id", habitIds);
            if (habitsError) throw habitsError;
            res.json({ success: true, invitations: (invitations || []).map(item => ({
                ...item, habit: habits?.find(habit => habit.id === item.habit_id) || null
            })) });
        } catch (error) {
            console.error("Ошибка загрузки приглашений:", error);
            res.status(500).json({ success: false });
        }
    });

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
                .select("id, user_id, members_can_invite").eq("id", req.params.id).maybeSingle();
            if (habitError) throw habitError;
            if (!habit) return res.status(404).json({ success: false });
            if (habit.user_id !== req.user.id) {
                const { data: member, error: memberError } = await supabase.from("habit_members")
                    .select("status").eq("habit_id", habit.id).eq("user_id", req.user.id)
                    .eq("status", "accepted").maybeSingle();
                if (memberError) throw memberError;
                if (!habit.members_can_invite || !member) return res.status(403).json({ success: false, error: "У вас нет прав приглашать в активность" });
            }
            const lookup = supabase.from("users").select("id");
            const { data: target, error: targetError } = await (typeof userId === "string"
                ? lookup.eq("id", userId) : lookup.eq("nick", nick.trim())).maybeSingle();
            if (target?.id === habit.user_id) return res.status(400).json({ success: false });
            if (targetError) throw targetError;
            if (!target) return res.status(404).json({ success: false });
            const { data: recipientSettings, error: settingsError } = await supabase.from("settings")
                .select("private").eq("user_id", target.id).maybeSingle();
            if (settingsError) throw settingsError;
            const privacy = recipientSettings?.private || {};
            const exception = privacy.activity_invite_exceptions?.[req.user.id];
            if (exception === "deny" || (exception !== "allow" && privacy.activity_invites === "nobody")) {
                return res.status(403).json({ success: false, error: "Пользователь ограничил приглашения в активности" });
            }
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
