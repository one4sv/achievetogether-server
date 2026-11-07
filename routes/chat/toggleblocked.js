import { authenticateUser } from "../../middleware/token.js"

export default function(app, supabase) {
    app.post("/toggleblocked", authenticateUser(supabase), async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false, error: "Не авторизован" });
        const userId = req.user.id;
        const targetId = req.body?.id;

        if (typeof targetId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetId) ||
            targetId === userId) {
            return res.status(400).json({ success: false, error: "Некорректный пользователь" });
        }

        try {
            const { data: target, error: userError } = await supabase.from("users")
                .select("id").eq("id", targetId).maybeSingle();
            if (userError) throw userError;
            if (!target) return res.status(404).json({ success: false, error: "Пользователь не найден" });

            // The old get_shared_chat RPC could return any two-member group.
            // A personal block must never modify a shared group membership.
            const { data: myChats, error: mineError } = await supabase.from("chat_members")
                .select("chat_id, chats!inner(is_group)")
                .eq("user_id", userId).eq("chats.is_group", false);
            if (mineError) throw mineError;
            const { data: theirChats, error: theirsError } = await supabase.from("chat_members")
                .select("chat_id, chats!inner(is_group)")
                .eq("user_id", targetId).eq("chats.is_group", false);
            if (theirsError) throw theirsError;

            const targetChats = new Set((theirChats || []).map(item => String(item.chat_id)));
            let chatId = (myChats || []).find(item => targetChats.has(String(item.chat_id)))?.chat_id;

            if (!chatId) {
                // Allow blocking from a profile, post or activity even before a DM exists.
                const { data: created, error: createError } = await supabase.from("chats")
                    .insert({ is_group: false }).select("id").single();
                if (createError || !created) throw createError || new Error("Chat not created");
                chatId = created.id;
                const { error: membersError } = await supabase.from("chat_members").insert([
                    { chat_id: chatId, user_id: userId, is_blocked: true },
                    { chat_id: chatId, user_id: targetId, is_blocked: false }
                ]);
                if (membersError) throw membersError;
                return res.json({ success: true, is_blocked: true });
            }

            const { data: current, error: memberError } = await supabase.from("chat_members")
                .select("is_blocked").eq("chat_id", chatId).eq("user_id", userId).maybeSingle();
            if (memberError) throw memberError;
            if (!current) return res.status(403).json({ success: false, error: "Нет доступа к чату" });

            const isBlocked = !current.is_blocked;
            const { error: updateError } = await supabase.from("chat_members")
                .update({ is_blocked: isBlocked }).eq("chat_id", chatId).eq("user_id", userId);
            if (updateError) throw updateError;

            return res.json({ success: true, is_blocked: isBlocked });
        } catch (error) {
            console.error("Ошибка переключения блокировки:", error);
            return res.status(500).json({ success: false, error: "Ошибка сервера" });
        }
    });
}
