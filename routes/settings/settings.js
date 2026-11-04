import { authenticateUser } from "../../middleware/token.js";

const withRetry = async (operation, maxRetries = 4) => {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (err) {
            lastError = err;

            const isNetworkError =
                err.message?.includes("fetch failed") ||
                err.cause?.message?.includes("fetch") ||
                err.name === "TypeError" ||
                err.code === "ECONNRESET" ||
                err.code === "ENOTFOUND";

            if (!isNetworkError || attempt === maxRetries) {
                console.error(`❌ Supabase запрос провалился:`, err);
                throw err;
            }

            const delay = Math.min(800 * Math.pow(2, attempt), 8000);
            await new Promise(r => setTimeout(r, delay));
        }
    }

    throw lastError;
};

export default function (app, supabase) {
    app.get("/settings", authenticateUser(supabase), async (req, res) => {
        const id = req.user?.id;

        if (!id) {
            return res.status(401).json({
                success: false,
                error: "Не авторизован"
            });
        }

        try {
            const { data, error } = await withRetry(() =>
                supabase
                    .from("settings")
                    .select("*")
                    .eq("user_id", id)
                    .maybeSingle()
            );

            if (error || !data) {
                return res.status(404).json({
                    success: false,
                    error: "Настройки не найдены"
                });
            }

            res.json({
                success: true,
                order: data.order,
                private: data.private,
                chat_welcome: data.chat_welcome ?? { enabled: false, text: "" },
                quick_actions: Array.isArray(data.quick_actions) ? data.quick_actions : [],
                group_invites: { contacts: data.group_invite_contacts ?? "message", others: data.group_invite_others ?? "none" },
                bg_url: data.bg_url,
                bg_gallery: Array.isArray(data.bg_gallery) ? data.bg_gallery : [],
                bg_effects: data.bg_effects ?? { blur: 0, movement: false, filter: "none" },
                twoAuth: data.two_auth,
                show_archived: data.show_archived,
                show_archived_in_acc: data.show_archived_in_acc,
                week_start: data.week_start
            });

        } catch (err) {
            console.error("Ошибка запроса к Supabase (/settings):", err);
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: "Ошибка сервера" });
            }
        }
    });

    app.post("/settings/invite-exception-users", authenticateUser(supabase), async (req, res) => {
        const id = req.user?.id;
        const requested = req.body?.user_ids;
        const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!id) return res.status(401).json({ success: false, error: "Не авторизован" });
        if (!Array.isArray(requested) || requested.length > 100 ||
            requested.some(userId => typeof userId !== "string" || !validUuid.test(userId))) {
            return res.status(400).json({ success: false, error: "Некорректный список пользователей" });
        }
        const userIds = [...new Set(requested)].filter(userId => userId !== id);
        if (!userIds.length) return res.json({ success: true, users: [] });

        try {
            const { data: profiles, error: usersError } = await supabase.from("users")
                .select("id, username, nick, avatar_url").in("id", userIds);
            if (usersError) throw usersError;
            const { data: ownChats, error: ownError } = await supabase.from("chat_members")
                .select("chat_id, is_blocked").eq("user_id", id).limit(10000);
            if (ownError) throw ownError;

            const chatIds = (ownChats || []).map(item => item.chat_id);
            const membersByChat = new Map();
            const blockedChats = new Set();
            let contactChats = new Set();
            if (chatIds.length) {
                const { data: members, error: membersError } = await supabase.from("chat_members")
                    .select("chat_id, user_id, is_blocked")
                    .in("chat_id", chatIds).in("user_id", userIds).limit(10000);
                if (membersError) throw membersError;
                const possibleIds = [...new Set((members || []).map(item => item.chat_id))];
                if (possibleIds.length) {
                    const { data: chats, error: chatsError } = await supabase.from("chats")
                        .select("id").in("id", possibleIds).eq("is_group", false);
                    if (chatsError) throw chatsError;
                    const privateIds = (chats || []).map(item => item.id);
                    if (privateIds.length) {
                        const privateSet = new Set(privateIds);
                        const ownByChat = new Map((ownChats || []).map(own => [own.chat_id, own]));
                        for (const member of members || []) {
                            if (!privateSet.has(member.chat_id)) continue;
                            membersByChat.set(member.chat_id, member.user_id);
                            if (member.is_blocked || ownByChat.get(member.chat_id)?.is_blocked) blockedChats.add(member.chat_id);
                        }
                        const { data: sent, error: sentError } = await supabase.from("messages")
                            .select("chat_id").in("chat_id", privateIds)
                            .eq("sender_id", id).eq("is_system", false).limit(10000);
                        if (sentError) throw sentError;
                        contactChats = new Set((sent || []).map(message => message.chat_id));
                    }
                }
            }

            const contacts = new Set();
            const blocked = new Set();
            for (const [chatId, userId] of membersByChat) {
                if (contactChats.has(chatId)) contacts.add(userId);
                if (blockedChats.has(chatId)) blocked.add(userId);
            }
            return res.json({
                success: true,
                users: (profiles || []).map(person => ({
                    id: person.id,
                    name: person.username || null,
                    nick: person.nick,
                    avatar_url: person.avatar_url || null,
                    is_contact: contacts.has(person.id),
                    is_blocked: blocked.has(person.id)
                }))
            });
        } catch (error) {
            console.error("[invite-exception-users]", error);
            return res.status(500).json({ success: false, error: "Не удалось загрузить пользователей" });
        }
    });
}
