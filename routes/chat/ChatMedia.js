import { authenticateUser } from "../../middleware/token.js";
import { getHabitAccess } from "../../utils/habitAccess.js";

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

    async function getRedirectedMedia(supabase, chatId, userId, category, beforeId, limit) {
        let query = supabase
            .from("messages")
            .select("id, redirected_id, created_at, sender_id")
            .eq("chat_id", chatId)
            .not("hidden", "cs", `{"${userId}"}`)
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


    // Library metadata is independent of the loaded message window.
    const read = async query => {
        const { data, error } = await query;
        if (error) throw error;
        return data || [];
    };
    const visible = (chatId, userId) => supabase.from("messages")
        .select("id,content,created_at,sender_id,redirected_id,entity_type,entity_id,message_files(id,file_url,file_name,file_type,file_size)")
        .eq("chat_id", chatId).not("hidden", "cs", '{"' + userId + '"}').eq("is_system", false);
    const categoryOf = file => getCategory(file.file_type) === "file" ? "file" : "media";
    async function expandRows(rows) {
        const originals = new Map();
        const ids = [...new Set(rows.map(row => row.redirected_id).filter(Boolean))];
        if (ids.length) {
            for (const original of await read(supabase.from("messages")
                .select("id,content,entity_type,entity_id,message_files(id,file_url,file_name,file_type,file_size)").in("id", ids))) originals.set(String(original.id), original);
        }
        return rows.map(row => ({ row, sources: [row, originals.get(String(row.redirected_id))].filter(Boolean) }));
    }
    function libraryItems(row, sources) {
        const items = [];
        const seen = new Set();
        for (const source of sources) {
            for (const file of source.message_files || []) {
                const key = "f:" + file.id;
                if (seen.has(key)) continue;
                seen.add(key);
                items.push({ id: row.id + ":" + key, message_id: row.id, url: file.file_url, name: file.file_name || "",
                    type: file.file_type || "", size: file.file_size || 0, created_at: row.created_at,
                    sender_id: row.sender_id, category: getCategory(file.file_type) });
            }
            for (const url of extractLinks(source.content)) {
                if (seen.has(url)) continue;
                seen.add(url);
                items.push({ id: row.id + ":l:" + items.length, message_id: row.id, url, name: url, type: "text/url",
                    size: 0, created_at: row.created_at, sender_id: row.sender_id, category: "link",
                    files: (source.message_files || []).map(file => ({
                        url: file.file_url, name: file.file_name || "", type: file.file_type || "", message_id: String(row.id)
                    })) });
            }
            if (source.entity_type && source.entity_id) {
                const key = source.entity_type + ":" + source.entity_id;
                if (!seen.has(key)) {
                    seen.add(key);
                    items.push({ id: row.id + ":e:" + key, message_id: row.id, url: "", name: "", type: "entity",
                        size: 0, created_at: row.created_at, sender_id: row.sender_id, category: "link",
                        entity_type: source.entity_type, entity_id: String(source.entity_id) });
                }
            }
        }
        return items;
    }
    async function linkedActivity(chatId, userId) {
        const [habits, plans] = await Promise.all([
            read(supabase.from("habits").select("id,name,user_id").eq("chat_id", chatId)),
            read(supabase.from("one_off_plans").select("id,name,owner_id").eq("chat_id", chatId))
        ]);
        const allowedHabits = [];
        for (const habit of habits) {
            const access = await getHabitAccess(supabase, habit.id, userId);
            if (access?.can_view) allowedHabits.push({ kind: "habit", id: String(habit.id), name: habit.name });
        }
        const membership = plans.length ? await read(supabase.from("one_off_plan_members").select("plan_id")
            .eq("user_id", userId).eq("status", "accepted").in("plan_id", plans.map(plan => plan.id))) : [];
        const accepted = new Set(membership.map(row => String(row.plan_id)));
        const allowedPlans = plans.filter(plan => plan.owner_id === userId || accepted.has(String(plan.id)))
            .map(plan => ({ kind: "plan", id: String(plan.id), name: plan.name }));
        const goals = allowedHabits.length ? await read(supabase.from("at_goals").select("*")
            .in("shared_habit_id", allowedHabits.map(habit => habit.id))) : [];
        const allowedGoals = [];
        for (const goal of goals) {
            // Do not expose other participants' personal instances or private goals.
            if (goal.template_goal_id && goal.owner_id !== userId) continue;
            const access = await getHabitAccess(supabase, goal.shared_habit_id, userId);
            if (!access?.is_member) continue;
            if (goal.owner_id !== userId && (access.habit.goal_scope !== "shared" || access.habit.goal_completion_mode !== "shared")) continue;
            allowedGoals.push({ kind: "goal", id: String(goal.id), name: goal.name });
        }
        return [...allowedHabits, ...allowedPlans, ...allowedGoals];
    }
    app.get("/chat/library/:id", authenticateUser(supabase), async (req, res) => {
        const userId = req.user?.id, chatId = req.params.id;
        if (!userId) return res.sendStatus(401);
        if (!/^\d+$/.test(chatId)) return res.sendStatus(400);
        res.set("Cache-Control", "private, no-store");
        try {
            const members = await read(supabase.from("chat_members").select("is_blocked").eq("chat_id", chatId).eq("user_id", userId).limit(1));
            if (!members.length || members[0].is_blocked) return res.sendStatus(403);
            // Exact totals use the same visibility, forwarding and deduplication rules
            // as the library pages. Only request them when opening the saved library.
            if (req.query.summary === "1") {
                const counts = { media: 0, link: 0, file: 0 };
                let before = null;
                for (;;) {
                    let query = visible(chatId, userId).order("id", { ascending: false }).limit(100);
                    if (before !== null) query = query.lt("id", before);
                    const rows = await read(query);
                    if (!rows.length) break;
                    for (const { row, sources } of await expandRows(rows)) {
                        for (const item of libraryItems(row, sources)) {
                            if (item.category === "photo" || item.category === "video") counts.media++;
                            else if (item.category === "link") counts.link++;
                            else if (item.category === "file") counts.file++;
                        }
                    }
                    if (rows.length < 100) break;
                    before = rows[rows.length - 1].id;
                }
                return res.json({ success: true, counts });
            }
            const category = req.query.category;
            if (category) {
                if (!["media","link","file"].includes(category)) return res.sendStatus(400);
                const cursor = req.query.beforeId ? /^(\d+):(\d+)$/.exec(String(req.query.beforeId)) : null;
                if (req.query.beforeId && (!cursor || !Number.isSafeInteger(Number(cursor[1])) || !Number.isSafeInteger(Number(cursor[2])))) return res.sendStatus(400);
                let before = cursor ? Number(cursor[1]) : null;
                let skip = cursor ? Number(cursor[2]) : 0;
                const result = [];
                let next = null;
                outer: for (;;) {
                    let query = visible(chatId, userId).order("id", { ascending: false }).limit(100);
                    if (before !== null) query = query.lte("id", before);
                    const rows = await read(query);
                    if (!rows.length) break;
                    for (const {row,sources} of await expandRows(rows)) {
                        const items = libraryItems(row, sources).filter(item => category === "media" ? ["photo","video"].includes(item.category) : item.category === category);
                        const start = before === Number(row.id) ? skip : 0;
                        for (let i = start; i < items.length; i++) {
                            if (result.length === 40) { next = row.id + ":" + i; break outer; }
                            result.push(items[i]);
                        }
                    }
                    before = Number(rows[rows.length - 1].id) - 1;
                    skip = 0;
                    if (rows.length < 100) break;
                }
                return res.json({ success: true, items: await addSenders(result), hasMore: next !== null, nextBeforeId: next });
            }
            const files = () => supabase.from("message_files").select("id,messages!inner(chat_id,hidden,is_system)")
                .eq("messages.chat_id", chatId).eq("messages.is_system", false).not("messages.hidden", "cs", '{"' + userId + '"}').limit(1);
            const [media, file, link, activity] = await Promise.all([
                read(files().or("file_type.ilike.image/%,file_type.ilike.video/%")),
                read(files().not("file_type","ilike","image/%").not("file_type","ilike","video/%")),
                read(visible(chatId,userId).or("content.ilike.%http://%,content.ilike.%https://%,entity_type.not.is.null").limit(1)),
                linkedActivity(chatId,userId)
            ]);
            const tabs = { media: media.length > 0, file: file.length > 0, link: link.length > 0, activity: activity.length > 0 };
            // Direct existence probes above avoid walking history; inspect forwarded messages only for missing categories.
            let before = null;
            while (!tabs.media || !tabs.file || !tabs.link) {
                let query = visible(chatId,userId).not("redirected_id","is",null).order("id",{ascending:false}).limit(100);
                if (before !== null) query = query.lt("id",before);
                const rows = await read(query);
                if (!rows.length) break;
                for (const {row,sources} of await expandRows(rows)) {
                    for (const item of libraryItems(row,sources)) {
                        if (["photo","video"].includes(item.category)) tabs.media = true;
                        else tabs[item.category] = true;
                    }
                }
                before = rows[rows.length-1].id;
                if (rows.length < 100) break;
            }
            const pins = [];
            let pinBefore = null;
            for (;;) {
                let query = visible(chatId,userId).eq("is_pinned",true).order("id",{ascending:false}).limit(100);
                if (pinBefore !== null) query = query.lt("id",pinBefore);
                const rows = await read(query);
                for (const {row,sources} of await expandRows(rows)) {
                    const source = sources[1] || row;
                    pins.push({...row, content: row.content || source.content || "", is_pinned:true,
                        files:(source.message_files || []).map(f => ({url:f.file_url,name:f.file_name,type:f.file_type})),
                        read_by:[], reactions:[]});
                }
                if (rows.length < 100) break;
                pinBefore = rows[rows.length-1].id;
            }
            const namedPins = (await addSenders(pins)).map(pin => ({...pin,sender_name:pin.sender.name,sender_nick:pin.sender.nick}));
            return res.json({success:true,tabs,activity,pins:namedPins.reverse()});
        } catch (error) {
            console.error("Chat library",error?.message);
            return res.sendStatus(500);
        }
    });

    app.get("/media/:type/:id", authenticateUser(supabase), async (req, res) => {
        if (!req.user?.id) return res.status(401).json({ success: false, error: "Authentication required" });
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
                    .select("chat_id, is_blocked")
                    .eq("chat_id", id)
                    .eq("user_id", userId)
                    .maybeSingle();

                if (error) throw error;

                if (!member || member.is_blocked) {
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

                if (receiver.id === userId) {
                    // Saved messages is a private chat containing only the caller.
                    for (const candidate of shared) {
                        const { count, error: countError } = await supabase
                            .from("chat_members")
                            .select("*", { count: "exact", head: true })
                            .eq("chat_id", candidate.chat_id);
                        if (countError) throw countError;
                        if (count === 1) {
                            chatId = candidate.chat_id;
                            break;
                        }
                    }
                    if (!chatId) return res.json({ success: true, items: [], hasMore: false, nextBeforeId: null });
                } else {
                    if (shared.length !== 1) {
                        return res.status(404).json({
                            success: false,
                            error: shared.length ? "Multiple personal chats found" : "Chat not found"
                        });
                    }
                    chatId = shared[0].chat_id;
                }
                const { data: ownMember, error: ownMemberError } = await supabase
                    .from("chat_members")
                    .select("is_blocked")
                    .eq("chat_id", chatId)
                    .eq("user_id", userId)
                    .maybeSingle();
                if (ownMemberError) throw ownMemberError;
                if (!ownMember || ownMember.is_blocked) {
                    return res.status(403).json({ success: false, error: "Access denied" });
                }
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
                            sender_id,
                            hidden
                        )
                    `)
                    .eq("messages.chat_id", chatId)
                    .not("messages.hidden", "cs", `{"${userId}"}`)
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
                    userId,
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
                    .not("hidden", "cs", `{"${userId}"}`)
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
                .not("hidden", "cs", `{"${userId}"}`)
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