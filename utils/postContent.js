export const visibilityValues = ["inherit", "all", "contacts", "nobody"];

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

export async function visiblePosts(supabase, posts, viewer) {
    if (!posts.length) return [];
    const authors = [...new Set(posts.map(post => post.user_id))];
    const { data: settings, error } = await supabase.from("settings")
        .select("user_id,private").in("user_id", authors);
    if (error) throw error;
    const defaults = new Map((settings || []).map(row => [row.user_id, row.private?.posts || "all"]));
    const visibility = post => post.visibility && post.visibility !== "inherit"
        ? post.visibility : defaults.get(post.user_id) || "all";
    const contacts = new Set();
    if (viewer && posts.some(post => post.user_id !== viewer && visibility(post) === "contacts")) {
        const { data: memberships, error: memberError } = await supabase.from("chat_members")
            .select("chat_id").eq("user_id", viewer).eq("is_blocked", false);
        if (memberError) throw memberError;
        const chatIds = (memberships || []).map(row => row.chat_id);
        if (chatIds.length) {
            const { data: chats, error: chatError } = await supabase.from("chats")
                .select("id").in("id", chatIds).eq("is_group", false);
            if (chatError) throw chatError;
            const personalIds = (chats || []).map(row => row.id);
            if (personalIds.length) {
                const { data: members, error: contactError } = await supabase.from("chat_members")
                    .select("user_id").in("chat_id", personalIds).in("user_id", authors).eq("is_blocked", false);
                if (contactError) throw contactError;
                (members || []).forEach(row => contacts.add(row.user_id));
            }
        }
    }
    return posts.filter(post => post.user_id === viewer || visibility(post) === "all"
        || (visibility(post) === "contacts" && contacts.has(post.user_id)));
}

export async function readablePost(supabase, id, viewer) {
    if (!/^\d+$/.test(String(id))) return null;
    const { data: post, error } = await supabase.from("posts").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!post) return null;
    return (await visiblePosts(supabase, [post], viewer))[0] || null;
}

export async function signedMedia(supabase, value, bucket) {
    const media = parseArray(value);
    const prefix = `/storage/v1/object/public/${bucket}/`;
    const paths = media.map(file => {
        try {
            return decodeURIComponent(new URL(file.url).pathname.split(prefix)[1] || "");
        } catch {
            return "";
        }
    });
    const requested = paths.filter(Boolean);
    if (!requested.length) return media;
    const { data, error } = await supabase.storage.from(bucket).createSignedUrls(requested, 3600);
    if (error) throw error;
    const urls = new Map((data || []).map(item => [item.path, item.signedUrl]));
    return media.map((file, index) => ({
        ...file,
        id: file.id || file.url,
        url: paths[index] ? urls.get(paths[index]) || "" : file.url
    }));
}

export async function signedRows(supabase, rows, field, bucket) {
    const files = rows.map(row => parseArray(row[field]));
    const signed = await signedMedia(supabase, files.flat(), bucket);
    let offset = 0;
    return rows.map((row, index) => {
        const media = signed.slice(offset, offset + files[index].length);
        offset += files[index].length;
        return { ...row, [field]: media };
    });
}
