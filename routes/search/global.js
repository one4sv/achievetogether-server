import { authenticateUser } from "../../middleware/token.js";
import { canAccessMessage } from "../../utils/messageAccess.js";
import { getHabitAccess } from "../../utils/habitAccess.js";
import { relationship } from "../../utils/privacy.js";
import { sharedEntityPreview, postCardExcerpt } from "../../utils/sharedEntity.js";
import { readablePost, visiblePosts } from "../../utils/postContent.js";

export const searchCategories = new Set(["ms", "com", "post", "user", "habit", "plan", "group", "every", "new"]);
export function parseGlobalQuery(input) {
    if (typeof input !== "string" || input.length > 120) return null;
    const text = input.trim();
    const match = /^\/(ms|com|post|setting|user|habit|plan|every|new|group)(?:\s+(.*))?$/iu.exec(text);
    if (text.startsWith("/") && !match) return null;
    const filter = match?.[1] || "every";
    const query = (match ? (match[2] || "") : text).trim();
    if ((!query && !["user","habit","plan","post","group","ms","new"].includes(filter)) ||
        query.length > 100 || query.includes("\0")) return null;
    return { filter, query, like: "%" + query.replace(/[\\%_]/g, "\\$&") + "%" };
}
const LIMIT = 20;
const idOf = value => String(value ?? "");
const safeText = value => String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, 150);
const result = (kind, id, label, url, description = "", date = "", visual = {}) =>
    ({ kind, id: String(id), label: safeText(label), description: safeText(description), url, date, ...visual });

export default function globalSearchRoutes(app, supabase) {
    app.get("/search/global", authenticateUser(supabase), async (req, res) => {
        const actor = req.user?.id;
        if (!actor) return res.status(401).json({ success: false });
        const parsed = parseGlobalQuery(req.query.q);
        const page = Number(req.query.page ?? 0);
        if (!parsed || !Number.isInteger(page) || page < 0 || page > 30)
            return res.status(400).json({ success: false, error: "Invalid search query" });
        const { filter, query, like } = parsed;
        const mineOnly = req.query.mine_only === "1" && (filter === "habit" || filter === "plan");
        // /invite in a group lists only the caller's unlinked activities and upcoming plans.
        const linkToChat = req.query.link_to_chat === "1" &&
            (filter === "habit" || filter === "plan");
        const wants = kind => filter === "every" || filter === kind || (filter === "new" && kind === "ms");
        try {
            const { data: mine, error: mineError } = await supabase.from("chat_members")
                .select("chat_id,is_blocked,joined_at").eq("user_id", actor).limit(1000);
            if (mineError) throw mineError;
            const memberships = (mine || []).filter(row => !row.is_blocked);
            const chatIds = memberships.map(row => row.chat_id);
            const joined = new Map(memberships.map(row => [idOf(row.chat_id), row.joined_at]));
            const [chatsResponse, othersResponse] = chatIds.length ? await Promise.all([
                supabase.from("chats").select("id,name,is_group").in("id", chatIds),
                supabase.from("chat_members").select("chat_id,user_id,is_blocked").in("chat_id", chatIds).limit(10000)
            ]) : [{ data: [] }, { data: [] }];
            if (chatsResponse.error || othersResponse.error) throw chatsResponse.error || othersResponse.error;
            const allMembers = othersResponse.data || [];
            const blocked = new Set(allMembers.filter(m => m.is_blocked).map(m => idOf(m.chat_id)));
            const chats = (chatsResponse.data || []).filter(chat => chat.is_group || !blocked.has(idOf(chat.id)));
            const allowed = new Set(chats.map(chat => idOf(chat.id)));
            const peers = [...new Set(allMembers.filter(m => !m.is_blocked && allowed.has(idOf(m.chat_id)))
                .map(m => m.user_id).filter(id => id !== actor))];
            const { data: people, error: peopleError } = peers.length
                ? await supabase.from("users").select("id,nick,username,avatar_url")
                    .in("id", peers.slice(0, 1000)).is("deletion_requested_at", null)
                : { data: [] };
            if (peopleError) throw peopleError;
            const profiles = new Map((people || []).map(person => [person.id, person]));
            const destination = new Map();
            for (const chat of chats) {
                const chatId = idOf(chat.id);
                const peer = allMembers.find(member => idOf(member.chat_id) === chatId &&
                    member.user_id !== actor && !member.is_blocked);
                destination.set(chatId, chat.is_group ? "/chat/g/" + encodeURIComponent(chatId) :
                    profiles.get(peer?.user_id)?.nick ? "/chat/" + encodeURIComponent(profiles.get(peer.user_id).nick) : null);
            }
            const results = [];
            const add = row => { if (row && results.length < 150) results.push(row); };
            const offset = page * LIMIT;
            if (wants("ms") && allowed.size) {
                const { data, error } = await supabase.from("messages")
                    .select("id,chat_id,content,sender_id,hidden,read_by,created_at")
                    .in("chat_id", [...allowed]).ilike("content", like)
                    .order("id", { ascending: false }).range(offset, offset + 79);
                if (error) throw error;
                for (const message of data || []) {
                    const cid = idOf(message.chat_id);
                    if (!allowed.has(cid) || !destination.get(cid) ||
                        message.hidden?.includes(actor) ||
                        joined.get(cid) && new Date(message.created_at) < new Date(joined.get(cid))) continue;
                    if (!(await canAccessMessage(supabase, message, actor))) continue;
                    if (filter === "new" && (message.sender_id === actor || message.read_by?.includes(actor))) continue;
                    add(result("ms", message.id, message.content, destination.get(cid) + "?message=" + message.id,
                        chats.find(chat => idOf(chat.id) === cid)?.name || profiles.get(message.sender_id)?.username || "", message.created_at));
                }
            }
            if (wants("group")) for (const chat of chats.filter(chat => chat.is_group &&
                chat.name?.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) {
                add(result("group", chat.id, chat.name, destination.get(idOf(chat.id))));
            }
            if (wants("user")) {
                // A typed @nickname or /user can share a profile outside this conversation.
                // The same server ACL used for card rendering is applied before disclosing a result.
                const searched = query ? await Promise.all([
                    supabase.from("users").select("id,nick,username")
                        .ilike("nick",like).is("deletion_requested_at",null).limit(40),
                    supabase.from("users").select("id,nick,username")
                        .ilike("username",like).is("deletion_requested_at",null).limit(40)
                ]) : [];
                if (searched.some(response => response.error)) throw searched.find(response => response.error).error;
                const candidates = query ? [...new Map(searched.flatMap(response => response.data || [])
                    .map(person => [person.id,person])).values()].slice(0,60) : (people || []).slice(0,40);
                for (const person of candidates || []) {
                    const visible = await sharedEntityPreview(supabase,"user",person.id,actor);
                    if (visible) add(result("user", person.id,visible.name,visible.url,"@" + person.nick, "",
                        { avatar_url: visible.avatar_url || null }));
                }
            }
            if (wants("habit")) {
                let habitsQuery = supabase.from("habits").select("id,name,created_at,user_id")
                    .ilike("name", like).order("id", { ascending: false });
                if (linkToChat) habitsQuery = habitsQuery.eq("user_id", actor).is("chat_id", null);
                else if (mineOnly) habitsQuery = habitsQuery.eq("user_id", actor);
                const { data, error } = await habitsQuery.limit(80);
                if (error) throw error;
                for (const habit of data || []) {
                    const access = await getHabitAccess(supabase, habit.id, actor);
                    if (access?.can_view) add(result("habit", habit.id, habit.name, "/habit/" + habit.id, "", habit.created_at,
                        { tag: access.habit?.tag || null, mine: idOf(habit.user_id) === idOf(actor) }));
                }
            }
            if (wants("plan")) {
                const { data: owned, error: ownedError } = await supabase.from("one_off_plans")
                    .select("id").eq("owner_id", actor).limit(500);
                const { data: memberships, error: planError } = linkToChat
                    ? { data: [], error: null }
                    : await supabase.from("one_off_plan_members")
                        .select("plan_id").eq("user_id", actor).eq("status", "accepted").limit(500);
                if (ownedError || planError) throw ownedError || planError;
                const ids = [...new Set([...(owned || []).map(x => x.id), ...(memberships || []).map(x => x.plan_id)])];
                if (ids.length) {
                    let plansQuery = supabase.from("one_off_plans")
                        .select("id,name,owner_id,plan_date,tag").in("id", ids).ilike("name", like);
                    if (linkToChat) plansQuery = plansQuery.eq("owner_id", actor)
                        .eq("status", "upcoming").is("chat_id", null);
                    else if (mineOnly) plansQuery = plansQuery.eq("owner_id", actor);
                    const { data, error } = await plansQuery.limit(80);
                    if (error) throw error;
                    for (const plan of data || []) {
                        if (plan.owner_id !== actor && (await relationship(supabase, actor, plan.owner_id)).blocked) continue;
                        add(result("plan", plan.id, plan.name, "/plan/" + plan.id, plan.plan_date, plan.plan_date,
                            { tag: plan.tag || null, mine: idOf(plan.owner_id) === idOf(actor) }));
                    }
                }
            }
            if (wants("post") || wants("com")) {
                if (wants("post")) {
                    const { data, error } = await supabase.from("posts").select("*")
                        .ilike("text", like).order("id", { ascending: false }).range(offset, offset + 39);
                    if (error) throw error;
                    const safe = await visiblePosts(supabase, data || [], actor);
                    const authorIds = [...new Set(safe.map(post => post.user_id).filter(Boolean))];
                    const { data: authors, error: authorsError } = authorIds.length
                        ? await supabase.from("users").select("id,username,nick,avatar_url").in("id", authorIds)
                        : { data: [], error: null };
                    if (authorsError) throw authorsError;
                    const authorMap = new Map((authors || []).map(author => [idOf(author.id), author]));
                    for (const post of safe) {
                        const author = authorMap.get(idOf(post.user_id));
                        add(result("post", post.id, postCardExcerpt(post.text), "/post/" + post.id,
                            author?.username || author?.nick || "", post.created_at,
                            { mine: idOf(post.user_id) === idOf(actor), avatar_url: author?.avatar_url || null }));
                    }
                }
                if (wants("com")) {
                    const { data, error } = await supabase.from("posts_comments")
                        .select("id,post_id,text,created_at").ilike("text", like)
                        .order("id", { ascending: false }).range(offset, offset + 39);
                    if (error) throw error;
                    for (const comment of data || []) {
                        if (!(await readablePost(supabase, comment.post_id, actor))) continue;
                        add(result("com", comment.id, comment.text,
                            "/post/" + comment.post_id + "?comment=" + comment.id, "", comment.created_at));
                    }
                }
            }
            results.sort((a,b) => (b.date || "").localeCompare(a.date || ""));
            return res.json({ success: true, filter, query, items: results.slice(0, LIMIT),
                hasMore: results.length > LIMIT });
        } catch (error) {
            console.error("Global search failed:", error?.message);
            return res.status(500).json({ success: false, error: "Search failed" });
        }
    });
}
