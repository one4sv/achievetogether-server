import { getHabitAccess } from "./habitAccess.js";
import { readablePost } from "./postContent.js";
import { ownerPrivacy, relationship, permitted } from "./privacy.js";

export function postCardExcerpt(text) {
    if (typeof text !== "string") return "";
    const maxLength = 700;
    try {
        const data = JSON.parse(text);
        if (data?.type !== "doc") return text.replace(/\s+/g, " ").slice(0, maxLength);
        const parts = [];
        const walk = node => {
            if (parts.join("").length > maxLength) return;
            if (node?.type === "text" && typeof node.text === "string") parts.push(node.text);
            if (Array.isArray(node?.content)) node.content.forEach(walk);
        };
        walk(data);
        return parts.join(" ").replace(/\s+/g, " ").slice(0, maxLength);
    } catch { return text.replace(/\s+/g, " ").slice(0, maxLength); }
}
export function validEntityReference(kind,id) {
    if (!["user","habit","plan","post","group"].includes(kind)) return false;
    if (typeof id !== "string" || id.length > 48) return false;
    return kind === "user" ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
        : /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id));
}
export async function sharedEntityPreview(supabase,kind,id,viewerId) {
    if (!viewerId || !validEntityReference(kind,id)) return null;
    if (kind === "habit") {
        const access = await getHabitAccess(supabase,id,viewerId);
        if (!access?.can_view) return null;
        return {kind,id,name:access.habit.name,periodicity:access.habit.periodicity || "",
            avatar_url:access.habit.avatar_key ? "/api/habits/"+access.habit.id+"/avatar/"+access.habit.avatar_key : null,
            tag:access.habit.tag || null,start_time:access.habit.start_time || null,
            end_time:access.habit.end_time || null,url:"/habit/"+id};
    }
    if (kind === "post") {
        const post = await readablePost(supabase,id,viewerId);
        if (!post) return null;
        const {data:author,error:authorError} = await supabase.from("users")
            .select("nick,username,avatar_url").eq("id",post.user_id).maybeSingle();
        if (authorError) throw authorError;
        return {kind,id,name:author?.username || author?.nick || "Post",
            author:author?.username || author?.nick || "",author_nick:author?.nick || null,
            avatar_url:author?.avatar_url || null,
            excerpt:postCardExcerpt(post.text),url:"/post/"+id};
    }
    if (kind === "user") {
        const {data:person,error} = await supabase.from("users").select("id,nick,username,avatar_url")
            .eq("id",id).is("deletion_requested_at",null).maybeSingle();
        if (error) throw error;
        if (!person) return null;
        const [owner,rel] = await Promise.all([ownerPrivacy(supabase,id),relationship(supabase,viewerId,id)]);
        if (rel.blocked || !permitted({rules:owner.rules,field:"profile",viewerId,ownerId:id,
            contact:rel.contact,blocked:rel.blocked})) return null;
        return {kind,id,name:person.username || person.nick,subtitle:"@"+person.nick,
            avatar_url:person.avatar_url,url:"/acc/"+encodeURIComponent(person.nick)};
    }
    if (kind === "group") {
        const {data:member,error} = await supabase.from("chat_members").select("is_blocked")
            .eq("chat_id",id).eq("user_id",viewerId).maybeSingle();
        if (error) throw error;
        if (!member || member.is_blocked) return null;
        const {data:chat,error:chatError} = await supabase.from("chats").select("name,is_group").eq("id",id).maybeSingle();
        if (chatError) throw chatError;
        return chat?.is_group ? {kind,id,name:chat.name || "Chat",subtitle:"",url:"/chat/g/"+id} : null;
    }
    const {data:plan,error} = await supabase.from("one_off_plans").select("*").eq("id",id).maybeSingle();
    if (error) throw error;
    if (!plan) return null;
    if (plan.owner_id !== viewerId) {
        const {data:member,error:memberError} = await supabase.from("one_off_plan_members").select("status")
            .eq("plan_id",id).eq("user_id",viewerId).maybeSingle();
        if (memberError) throw memberError;
        const [owner,rel] = await Promise.all([ownerPrivacy(supabase,plan.owner_id),
            relationship(supabase,viewerId,plan.owner_id)]);
        if (rel.blocked) return null;
        const publicAccess = permitted({rules:owner.rules,field:"plans",viewerId,ownerId:plan.owner_id,
            contact:rel.contact,blocked:rel.blocked,override:plan.visibility,token:plan.share_token});
        if (member?.status !== "accepted" && !publicAccess) return null;
    }
    return {kind,id,name:plan.name,plan_date:plan.plan_date || null,
        start_time:plan.start_time || null,end_time:plan.end_time || null,
        tag:plan.tag || null,url:"/plan/"+id};
}

