import { relationship,permitted,defaults } from "./privacy.js";
import { normalizeUploadFileName } from "./fileNameEncoding.js";

export const visibilityValues = ["inherit", "all", "contacts", "nobody", "link"];

export function parseArray(value) {
    if (typeof value === "string") value = JSON.parse(value);
    return Array.isArray(value) ? value : [];
}

export function validateContent(value, media) {
    if (!value) return null;
    const document = typeof value === "string" ? JSON.parse(value) : value;
    if (JSON.stringify(document).length > 1000000 || document?.type !== "doc") {
        throw new Error("Invalid post document");
    }
    const ids = new Set(media.map(file => file.id || file.url));
    const blocks = new Set(["paragraph", "heading", "blockquote", "bulletList", "orderedList", "listItem", "hardBreak"]);
    const marks = new Set(["bold", "italic", "underline", "strike", "code", "link"]);
    let count = 0;
    const visit = (node, depth = 0) => {
        if (!node || depth > 20 || ++count > 20000) throw new Error("Invalid post document");
        if (node.type === "text") {
            if (typeof node.text !== "string") throw new Error("Invalid post text");
            return {
                type: "text",
                text: node.text,
                marks: (node.marks || []).map(mark => {
                    if (!marks.has(mark.type)) throw new Error("Invalid formatting");
                    if (mark.type !== "link") return { type: mark.type };
                    const href = mark.attrs?.href;
                    if (typeof href !== "string" || !/^(https?:\/\/|\/(?!\/))/i.test(href) || href.length > 4000) {
                        throw new Error("Invalid link");
                    }
                    return { type: "link", attrs: { href } };
                })
            };
        }
        if (node.type === "postMedia") {
            if (!ids.has(node.attrs?.id)) throw new Error("Unknown media reference");
            return { type: "postMedia", attrs: { id: node.attrs.id } };
        }
        if (node.type !== "doc" && !blocks.has(node.type)) throw new Error("Invalid document node");
        if (node.type === "doc" && depth !== 0) throw new Error("Nested document");
        const result = { type: node.type };
        if (node.type === "heading") result.attrs = { level: 2 };
        if (node.content) {
            if (!Array.isArray(node.content)) throw new Error("Invalid content");
            result.content = node.content.map(child => visit(child, depth + 1));
        }
        return result;
    };
    return visit(document);
}

export async function visiblePosts(supabase, posts, viewer, share = null) {
    if (!posts.length) return [];
    const authors = [...new Set(posts.map(post => post.user_id))];
    const { data: settings,error } = await supabase.from("settings")
        .select("user_id,private,profile_share_token").in("user_id",authors);
    if (error) throw error;
    const byOwner = new Map((settings || []).map(row => [row.user_id,row]));
    const access = new Map();
    for (const author of authors) {
        if (viewer && viewer === author) continue;
        access.set(author,await relationship(supabase,viewer,author));
    }
    return posts.filter(post => {
        const row = byOwner.get(post.user_id);
        const rel = access.get(post.user_id) || { contact:false,blocked:false };
        return permitted({ rules:{ ...defaults,...row?.private },field:"posts",
            viewerId:viewer,ownerId:post.user_id,contact:rel.contact,blocked:rel.blocked,
            token:row?.profile_share_token,share,override:post.visibility });
    });
}

export async function readablePost(supabase, id, viewer, share = null) {
    if (!/^\d+$/.test(String(id))) return null;
    const { data: post,error } = await supabase.from("posts").select("*").eq("id",id).maybeSingle();
    if (error) throw error;
    if (!post) return null;
    return (await visiblePosts(supabase,[post],viewer,share))[0] || null;
}

// Keep the existing API schema, but never grant a standalone Storage token.
export function signedMedia(_supabase, value, bucket, resourceId, share = null) {
    if (!["posts", "comments"].includes(bucket) || !/^\d+$/.test(String(resourceId))) {
        throw new Error("Post media requires a valid resource owner");
    }
    const prefix = bucket === "posts" ? "post-asset" : "comment-asset";
    const shareQuery = typeof share === "string" && share.length <= 100
        ? "?share=" + encodeURIComponent(share) : "";
    return parseArray(value).map((file, index) => ({
        ...file,
        name: typeof file.name === "string" ? normalizeUploadFileName(file.name) : file.name,
        id: file.id || file.url,
        url: "/api/" + prefix + "/" + resourceId + "/" + index + shareQuery
    }));
}

export async function signedRows(supabase, rows, field, bucket, share = null) {
    return rows.map(row => ({
        ...row,
        [field]: signedMedia(supabase, row[field], bucket, row.id, share)
    }));
}
