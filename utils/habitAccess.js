export async function getHabitAccess(supabase, habitId, userId) {
    const { data: habit, error } = await supabase.from("habits").select("*").eq("id", habitId).maybeSingle();
    if (error) throw error;
    if (!habit) return null;
    const { data: permissions, error: permissionError } = await supabase.rpc("habit_permissions", {
        p_actor: userId || null,
        p_habit: habit.id
    });
    if (permissionError) throw permissionError;
    if (habit.chat_id && userId && !permissions?.is_owner) {
        const { data: member, error: memberError } = await supabase.from("chat_members")
            .select("is_blocked").eq("chat_id", habit.chat_id).eq("user_id", userId).maybeSingle();
        if (memberError) throw memberError;
        if (member?.is_blocked) return {
            habit,
            is_owner: false,
            is_member: false,
            can_view: false,
            can_complete: false,
            can_comment: false,
            can_edit_blocks: false,
            can_edit_info: false,
            can_invite: false
        };
    }
    let canView = !!permissions?.is_member;
    if (!canView) {
        const { data: settings, error: settingsError } = await supabase.from("settings")
            .select("private, show_archived_in_acc").eq("user_id", habit.user_id).maybeSingle();
        if (settingsError) throw settingsError;
        const visibility = settings?.private?.habits || "all";
        canView = visibility === "all";
        if (visibility === "contacts" && userId) {
            const { data: myChats, error: myError } = await supabase.from("chat_members")
                .select("chat_id").eq("user_id", userId).eq("is_blocked", false);
            if (myError) throw myError;
            const ids = (myChats || []).map(item => item.chat_id);
            if (ids.length) {
                const { data: ownerChats, error: ownerError } = await supabase.from("chat_members")
                    .select("chat_id, chats!inner(is_group)").eq("user_id", habit.user_id)
                    .eq("is_blocked", false).in("chat_id", ids).eq("chats.is_group", false).limit(1);
                if (ownerError) throw ownerError;
                canView = !!ownerChats?.length;
            }
        }
        if (!habit.ongoing && !settings?.show_archived_in_acc) canView = false;
    }
    return {
        habit,
        ...permissions,
        can_view: canView,
        progress_user_id: habit.metric_progress_mode === "shared" || !permissions?.is_member ? habit.user_id : userId,
        block_user_id: habit.schedule_blocks_mode === "shared" || !permissions?.is_member ? habit.user_id : userId
    };
}

export function requireHabitPermission(supabase, action, getId = req => req.body?.habit_id ?? req.params.id ?? req.params.habit_id) {
    return async (req, res, next) => {
        try {
            if (!req.user?.id) return res.status(401).json({ success: false, error: "Войдите в аккаунт" });
            const access = await getHabitAccess(supabase, await getId(req), req.user.id);
            if (!access || !(action === "view" ? access.can_view : access["can_" + action])) {
                return res.status(403).json({ success: false, error: "Нет прав на это действие в активности" });
            }
            req.habitAccess = access;
            next();
        } catch (error) {
            console.error("Ошибка доступа к активности:", error);
            res.status(500).json({ success: false, error: "Не удалось проверить права" });
        }
    };
}

export async function filterBlockedHabitMemberships(supabase, habits, userId) {
    const chatIds = [...new Set((habits || [])
        .filter(habit => habit.user_id !== userId && habit.chat_id)
        .map(habit => habit.chat_id))];
    if (!chatIds.length) return habits || [];
    const { data, error } = await supabase.from("chat_members")
        .select("chat_id").eq("user_id", userId).eq("is_blocked", true)
        .in("chat_id", chatIds);
    if (error) throw error;
    const blocked = new Set((data || []).map(member => member.chat_id));
    return (habits || []).filter(habit =>
        habit.user_id === userId || !habit.chat_id || !blocked.has(habit.chat_id)
    );
}
