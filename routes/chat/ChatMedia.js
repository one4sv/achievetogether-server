import { authenticateUser } from "../../middleware/token.js";

const validCategories = ["photo", "video", "link", "file"];

function getCategory(fileType) {
    const mime = (fileType || "").toLowerCase();

    if (mime.startsWith("image/")) return "photo";
    if (mime.startsWith("video/")) return "video";

    return "file";
}

function extractLinks(content) {
    const matches = (content || "").match(/https?:\/\/[^\s<>"']+/gi) || [];

    return [...new Set(matches.map(url => url.replace(/[),.!?;:]+$/, "")))];
}

export default function (app, supabase) {
    async function addSenders(items) {
        const senderIds = [...new Set(items.map(item => item.sender_id).filter(Boolean))];

        if (!senderIds.length) {
            return items.map(item => ({
                ...item,
                sender: { id: item.sender_id || "", nick: "", name: "", url: "" }
            }));
        }

        const { data: users, error } = await supabase
            .from("users")
            .select("id, nick, username, avatar_url")
            .in("id", senderIds);

        if (error) throw error;

        const senders = new Map(
            (users || []).map(user => [
                user.id,
                {
                    id: user.id,
                    nick: user.nick || "",
                    name: user.username || "",
                    url: user.avatar_url || ""
                }
            ])
        );

        return items.map(item => ({
            ...item,
            sender: senders.get(item.sender_id) || {
                id: item.sender_id || "",
                nick: "",
                name: "",
                url: ""
            }
        }));
    }

    async function getRedirectedMedia(supabase, chatId, category, beforeId, limit) {
        let query = supabase
            .from("messages")
            .select("id, redirected_id, created_at, sender_id")
            .eq("chat_id", chatId)
            .not("redirected_id", "is", null)
            .order("id", { ascending: false })
            .limit(1000);

        const { data: redirects, error } = await query;

        if (error) throw error;
        if (!redirects?.length) return [];

        const originalIds = [...new Set(
            redirects.map(message => Number(message.redirected_id))
                .filter(id => Number.isSafeInteger(id) && id > 0)
        )];

        if (!originalIds.length) return [];

        let filesQuery = supabase
            .from("message_files")
            .select("id, message_id, file_url, file_name, file_type, file_size, created_at")
            .in("message_id", originalIds)
            .order("id", { ascending: false });

        if (category === "photo") {
            filesQuery = filesQuery.ilike("file_type", "image/%");
        } else if (category === "video") {
            filesQuery = filesQuery.ilike("file_type", "video/%");
        } else {
            filesQuery = filesQuery
                .not("file_type", "ilike", "image/%")
                .not("file_type", "ilike", "video/%");
        }

        const { data: files, error: filesError } = await filesQuery;

        if (filesError) throw filesError;

        const redirectsByOriginal = new Map();

        for (const redirect of redirects) {
            const originalId = Number(redirect.redirected_id);

            if (!redirectsByOriginal.has(originalId)) {
                redirectsByOriginal.set(originalId, []);
            }

            redirectsByOriginal.get(originalId).push(redirect);
        }

        const items = [];

        for (const file of files || []) {
            const matchingRedirects = redirectsByOriginal.get(Number(file.message_id)) || [];

            for (const redirect of matchingRedirects) {
                items.push({
                    id: file.id,
                    message_id: redirect.id,
                    original_message_id: file.message_id,
                    url: file.file_url,
                    name: file.file_name || "",
                    type: (file.file_type || "").toLowerCase(),
                    size: file.file_size || 0,
                    created_at: redirect.created_at || file.created_at,
                    sender_id: redirect.sender_id || "",
                    category: getCategory(file.file_type),
                    is_redirected: true
                });
            }
        }

        return items;
    }

    app.get("/media/:type/:id", authenticateUser(supabase), async (req, res) => {
        try {
            const userId = req.user.id;
            const { type, id } = req.params;
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 100);
            const category = req.query.category || "photo";
            const rawBeforeId = req.query.beforeId;

            if (!["user", "group"].includes(type) || !id) {
                return res.status(400).json({ success: false, error: "Invalid parameters" });
            }

            if (!validCategories.includes(category)) {
                return res.status(400).json({ success: false, error: "Invalid category" });
            }

            let chatId;

            if (type === "group") {
                const { data: member, error } = await supabase
                    .from("chat_members")
                    .select("chat_id")
                    .eq("chat_id", id)
                    .eq("user_id", userId)
                    .maybeSingle();

                if (error) throw error;

                if (!member) {
                    return res.status(403).json({ success: false, error: "Access denied" });
                }

                chatId = member.chat_id;
            } else {
                const { data: receiver, error: receiverError } = await supabase
                    .from("users")
                    .select("id")
                    .eq("nick", id)
                    .maybeSingle();

                if (receiverError) throw receiverError;

                if (!receiver) {
                    return res.status(404).json({ success: false, error: "User not found" });
                }

                const { data: myChats, error: myChatsError } = await supabase
                    .from("chat_members")
                    .select("chat_id, chats!inner(is_group)")
                    .eq("user_id", userId)
                    .eq("chats.is_group", false);

                if (myChatsError) throw myChatsError;

                const { data: theirChats, error: theirChatsError } = await supabase
                    .from("chat_members")
                    .select("chat_id, chats!inner(is_group)")
                    .eq("user_id", receiver.id)
                    .eq("chats.is_group", false);

                if (theirChatsError) throw theirChatsError;

                const theirIds = new Set((theirChats || []).map(chat => chat.chat_id));
                const shared = (myChats || []).filter(chat => theirIds.has(chat.chat_id));

                if (shared.length !== 1) {
                    return res.status(404).json({
                        success: false,
                        error: shared.length ? "Multiple personal chats found" : "Chat not found"
                    });
                }

                chatId = shared[0].chat_id;
            }

            let beforeId = null;

            if (rawBeforeId !== undefined && rawBeforeId !== "") {
                beforeId = String(rawBeforeId);

                if (category === "link") {
                    const match = /^(\d+):(\d+)$/.exec(beforeId);

                    if (
                        !match ||
                        !Number.isSafeInteger(Number(match[1])) ||
                        !Number.isSafeInteger(Number(match[2]))
                    ) {
                        return res.status(400).json({ success: false, error: "Invalid cursor" });
                    }
                } else if (!/^\d+$/.test(beforeId) || Number(beforeId) <= 0) {
                    return res.status(400).json({ success: false, error: "Invalid cursor" });
                }
            }

            if (category !== "link") {
                let query = supabase
                    .from("message_files")
                    .select(`
                        id,
                        message_id,
                        file_url,
                        file_name,
                        file_type,
                        file_size,
                        created_at,
                        messages!inner (
                            id,
                            chat_id,
                            created_at,
                            sender_id
                        )
                    `)
                    .eq("messages.chat_id", chatId)
                    .order("id", { ascending: false })
                    .limit(1000);

                if (beforeId !== null) {
                    query = query.lt("id", Number(beforeId));
                }

                if (category === "photo") {
                    query = query.ilike("file_type", "image/%");
                } else if (category === "video") {
                    query = query.ilike("file_type", "video/%");
                } else {
                    query = query
                        .not("file_type", "ilike", "image/%")
                        .not("file_type", "ilike", "video/%");
                }

                const { data: files, error } = await query;

                if (error) throw error;

                const directItems = (files || []).map(file => ({
                    id: file.id,
                    message_id: file.message_id,
                    url: file.file_url,
                    name: file.file_name || "",
                    type: (file.file_type || "").toLowerCase(),
                    size: file.file_size || 0,
                    created_at: file.messages?.created_at || file.created_at,
                    sender_id: file.messages?.sender_id || "",
                    category: getCategory(file.file_type),
                    is_redirected: false
                }));

                const redirectedItems = await getRedirectedMedia(
                    supabase,
                    chatId,
                    category,
                    beforeId,
                    limit
                );

                const uniqueItems = new Map();

                for (const item of [...directItems, ...redirectedItems]) {
                    const key = `${item.message_id}:${item.id}:${item.is_redirected}`;
                    uniqueItems.set(key, item);
                }

                const sortedItems = [...uniqueItems.values()].sort((a, b) => {
                    const dateDiff = new Date(b.created_at).getTime() -
                        new Date(a.created_at).getTime();

                    return dateDiff || Number(b.id) - Number(a.id);
                });

                const hasMore = sortedItems.length > limit;
                const page = sortedItems.slice(0, limit);

                return res.json({
                    success: true,
                    items: await addSenders(page),
                    hasMore,
                    nextBeforeId: hasMore ? page[page.length - 1]?.id ?? null : null
                });
            }

            let cursorMessageId = null;
            let cursorLinkIndex = null;

            if (beforeId !== null) {
                const [messageId, linkIndex] = beforeId.split(":").map(Number);
                cursorMessageId = messageId;
                cursorLinkIndex = linkIndex;
            }

            const items = [];
            let scanBeforeId = cursorMessageId;
            let firstBatch = true;

            while (items.length <= limit) {
                let query = supabase
                    .from("messages")
                    .select("id, content, created_at, sender_id")
                    .eq("chat_id", chatId)
                    .not("content", "is", null)
                    .order("id", { ascending: false })
                    .limit(100);

                if (scanBeforeId !== null) {
                    query = query.lte("id", scanBeforeId);
                }

                const { data: messages, error } = await query;

                if (error) throw error;
                if (!messages?.length) break;

                for (const message of messages) {
                    const links = extractLinks(message.content);
                    let startIndex = 0;

                    if (
                        firstBatch &&
                        cursorMessageId !== null &&
                        message.id === cursorMessageId
                    ) {
                        startIndex = cursorLinkIndex + 1;
                    }

                    for (let index = startIndex; index < links.length; index++) {
                        items.push({
                            id: `link-${message.id}-${index}`,
                            message_id: message.id,
                            url: links[index],
                            name: links[index],
                            type: "text/url",
                            size: 0,
                            created_at: message.created_at,
                            sender_id: message.sender_id,
                            category: "link",
                            is_redirected: false
                        });

                        if (items.length > limit) break;
                    }

                    if (items.length > limit) break;
                    firstBatch = false;
                }

                if (items.length > limit) break;

                scanBeforeId = Number(messages[messages.length - 1].id) - 1;
                firstBatch = false;

                if (messages.length < 100) break;
            }

            const { data: redirects, error: redirectsError } = await supabase
                .from("messages")
                .select("id, redirected_id, created_at, sender_id")
                .eq("chat_id", chatId)
                .not("redirected_id", "is", null)
                .order("id", { ascending: false })
                .limit(1000);

            if (redirectsError) throw redirectsError;

            const originalIds = [...new Set(
                (redirects || [])
                    .map(message => Number(message.redirected_id))
                    .filter(id => Number.isSafeInteger(id) && id > 0)
            )];

            if (originalIds.length) {
                const { data: originals, error: originalsError } = await supabase
                    .from("messages")
                    .select("id, content")
                    .in("id", originalIds);

                if (originalsError) throw originalsError;

                const originalsById = new Map(
                    (originals || []).map(message => [Number(message.id), message])
                );

                for (const redirect of redirects || []) {
                    const original = originalsById.get(Number(redirect.redirected_id));

                    if (!original?.content) continue;

                    const links = extractLinks(original.content);

                    links.forEach((url, index) => {
                        items.push({
                            id: `link-${redirect.id}-${index}`,
                            message_id: redirect.id,
                            original_message_id: original.id,
                            url,
                            name: url,
                            type: "text/url",
                            size: 0,
                            created_at: redirect.created_at,
                            sender_id: redirect.sender_id || "",
                            category: "link",
                            is_redirected: true
                        });
                    });
                }
            }

            const uniqueLinks = new Map();

            for (const item of items) {
                uniqueLinks.set(String(item.id), item);
            }

            const sortedItems = [...uniqueLinks.values()].sort((a, b) => {
                const dateDiff = new Date(b.created_at).getTime() -
                    new Date(a.created_at).getTime();

                return dateDiff || String(b.id).localeCompare(String(a.id));
            });

            const hasMore = sortedItems.length > limit;
            const page = sortedItems.slice(0, limit);
            let nextBeforeId = null;

            if (hasMore && page.length) {
                const lastItem = page[page.length - 1];
                const match = /^link-(\d+)-(\d+)$/.exec(String(lastItem.id));

                if (match) {
                    nextBeforeId = `${match[1]}:${match[2]}`;
                }
            }

            return res.json({
                success: true,
                items: await addSenders(page),
                hasMore,
                nextBeforeId
            });
        } catch (error) {
            console.error("Ошибка загрузки медиа:", error);

            return res.status(500).json({
                success: false,
                error: "Server error"
            });
        }
    });
}