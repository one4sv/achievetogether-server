export const VIEW_RULES = ["all","contacts","nobody","link"];
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXCEPTION = new Set(["allow","deny","invert"]);
export const defaults = { profile:"all",habits:"all",posts:"all",plans:"nobody",plan_invites:"contacts" };

export function isShareToken(value, expected) {
    return typeof value === "string" && ID.test(value) &&
        typeof expected === "string" && value.toLowerCase() === expected.toLowerCase();
}

export async function ownerPrivacy(supabase,ownerId) {
    const { data,error } = await supabase.from("settings")
        .select("private,profile_share_token").eq("user_id",ownerId).maybeSingle();
    if (error) throw error;
    return { rules:{ ...defaults,...(data?.private || {}) }, token:data?.profile_share_token || null };
}

// Only unblocked personal conversations establish contact status.
export async function relationship(supabase,viewerId,ownerId) {
    if (!viewerId || !ownerId || viewerId === ownerId) return { contact:false,blocked:false };
    const { data: mine,error } = await supabase.from("chat_members")
        .select("chat_id,is_blocked").eq("user_id",viewerId).limit(500);
    if (error) throw error;
    if (!mine?.length) return { contact:false,blocked:false };
    const ids = mine.map(row => row.chat_id);
    const [{ data: theirs,error:otherError },{ data:chats,error:chatError }] = await Promise.all([
        supabase.from("chat_members").select("chat_id,is_blocked").eq("user_id",ownerId).in("chat_id",ids),
        supabase.from("chats").select("id").eq("is_group",false).in("id",ids)
    ]);
    if (otherError || chatError) throw otherError || chatError;
    const personal = new Set((chats || []).map(row => String(row.id)));
    const own = new Map(mine.map(row => [String(row.chat_id),row]));
    let contact = false,blocked = false;
    for (const item of theirs || []) {
        const key = String(item.chat_id);
        if (!personal.has(key)) continue;
        if (item.is_blocked || own.get(key)?.is_blocked) blocked = true;
        else contact = true;
    }
    return { contact:contact && !blocked,blocked };
}

export function permitted({ rules = {},field,viewerId,ownerId,contact = false,blocked = false,
    share = null,token = null,override = null }) {
    if (viewerId && viewerId === ownerId) return true;
    if (blocked) return false;
    const rule = override && override !== "inherit" ? override : (rules[field] || defaults[field] || "nobody");
    const base = rule === "all" || (rule === "contacts" && contact)
        || (rule === "link" && isShareToken(share,token));
    const exception = viewerId && rules[field + "_exceptions"]?.[viewerId];
    if (!EXCEPTION.has(exception)) return base;
    if (exception === "allow") return true;
    if (exception === "deny") return false;
    return !base;
}

export function validatePrivacy(body,old = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const rules = { ...old };
    const fields = ["profile","habits","posts","plans","activity_invites","plan_invites","presence"];
    const exceptionFields = ["profile_exceptions","habits_exceptions","posts_exceptions","plans_exceptions",
        "activity_invite_exceptions","group_invite_exceptions","plan_invite_exceptions"];
    const legacy = ["number","mail"];
    for (const [key,value] of Object.entries(body)) {
        if (fields.includes(key) || legacy.includes(key)) {
            if (typeof value !== "string" ||
                !(key.endsWith("_invites") || key === "activity_invites"
                    ? ["all","contacts","nobody"].includes(value) : VIEW_RULES.includes(value) ||
                        (legacy.includes(key) && ["all","contacts","nobody"].includes(value)))) return null;
            rules[key] = value;
        } else if (exceptionFields.includes(key)) {
            if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 100 ||
                Object.entries(value).some(([id,kind]) => !ID.test(id) || !EXCEPTION.has(kind))) return null;
            rules[key] = value;
        } else return null;
    }
    return rules;
}
