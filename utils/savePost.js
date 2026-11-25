import crypto from "crypto";
import { validPostLink, validatePostLinks } from "./postLinks.js";
import path from "path";
import { parseArray, validateContent, visibilityValues } from "./postContent.js";
import { normalizeUploadFileName } from "./fileNameEncoding.js";

export { normalizeUploadFileName } from "./fileNameEncoding.js";

export function savePost(supabase, editing) {
    return async (req, res) => {
        const user_id = req.user?.id;
        if (!user_id) return res.status(401).json({ success: false });
        let createdId;
        const uploaded = [];
        let committed = false;
        try {
            let post;
            if (editing) {
                const result = await supabase.from("posts").select("*").eq("id", req.body.id).maybeSingle();
                if (result.error) throw result.error;
                post = result.data;
                if (!post || post.user_id !== user_id) return res.status(403).json({ success: false });
            }
            const files = req.files || [];
            const current = parseArray(post?.media);
            let kept;
            let content;
            let ids;
            let visibility;
            let habit_id, goal_id, plan_id;
            const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
            try {
                const requested = parseArray(req.body.keptMedia);
                kept = current.filter(file => requested.some(item => (item.id && item.id === (file.id || file.url)) || item.url === file.url));
                ids = req.body.media_ids ? parseArray(req.body.media_ids) : files.map(() => crypto.randomUUID());
                if (ids.length !== files.length || ids.some(id => typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id))) {
                    throw new Error("Invalid media ids");
                }
                const allIds = [...kept.map(file => file.id || file.url), ...ids];
                if (new Set(allIds).size !== allIds.length) throw new Error("Duplicate media ids");
                if (kept.length + files.length > 20 || text.length > 100000 || (!text && !kept.length && !files.length)) {
                    throw new Error("Invalid post size");
                }
                content = validateContent(req.body.content, [...kept, ...ids.map(id => ({ id }))]);
                visibility = req.body.visibility ?? post?.visibility ?? "inherit";
                if (!visibilityValues.includes(visibility)) throw new Error("Invalid visibility");
                habit_id = req.body.habit_id === undefined ? post?.habit_id ?? null
                    : req.body.habit_id === "none" ? null : req.body.habit_id;
                goal_id = req.body.goal_id === undefined ? post?.goal_id ?? null : req.body.goal_id === "none" ? null : req.body.goal_id;
                plan_id = req.body.plan_id === undefined ? post?.plan_id ?? null : req.body.plan_id === "none" ? null : req.body.plan_id;
                if (![habit_id,goal_id,plan_id].every(validPostLink)) throw new Error("Invalid link");
            } catch {
                return res.status(400).json({ success: false, message: "Invalid post" });
            }
            const links={habit_id,goal_id,plan_id};
            if ((!editing || Object.keys(links).some(k=>String(links[k] ?? "")!==String(post?.[k] ?? ""))) && !(await validatePostLinks(supabase,user_id,links,req.body.timezone))) return res.status(400).json({success:false,message:"Invalid post links"});
            if (!editing) {
                // Keep the unfinished row private until every upload succeeds.
                const result = await supabase.from("posts")
                    .insert({ user_id, text: "", media: [], visibility: "nobody" }).select("id").single();
                if (result.error) throw result.error;
                createdId = result.data.id;
            }
            const post_id = post?.id || createdId;
            const media = [...kept];
            for (let index = 0; index < files.length; index++) {
                const file = files[index];
                const originalName = normalizeUploadFileName(file.originalname);
                const extension = path.extname(originalName).replace(/[^.a-zA-Z0-9]/g, "").slice(0, 12);
                const filePath = `${user_id}/${post_id}/${crypto.randomUUID()}${extension}`;
                const { error } = await supabase.storage.from("posts").upload(filePath, file.buffer, {
                    contentType: file.mimetype
                });
                if (error) throw error;
                uploaded.push(filePath);
                const { data } = supabase.storage.from("posts").getPublicUrl(filePath);
                media.push({ id: ids[index], name: originalName, type: file.mimetype, url: data.publicUrl });
            }
            const { error } = await supabase.from("posts")
                .update({ text, content, media, visibility, habit_id, goal_id, plan_id }).eq("id", post_id).eq("user_id", user_id);
            if (error) throw error;
            committed = true;
            // Remove old objects only after the replacement has been saved successfully.
            const removed = current.filter(file => !kept.some(item => item.url === file.url))
                .map(file => file.url.split("/storage/v1/object/public/posts/")[1])
                .filter(value => value?.startsWith(`${user_id}/${post_id}/`));
            if (removed.length) {
                try {
                    const cleanup = await supabase.storage.from("posts").remove(removed);
                    if (cleanup.error) console.error("Post media cleanup failed", cleanup.error);
                } catch (cleanupError) {
                    console.error("Post media cleanup failed", cleanupError);
                }
            }
            return res.json({ success: true, post_id });
        } catch (error) {
            if (!committed) {
                if (uploaded.length) await supabase.storage.from("posts").remove(uploaded).catch(console.error);
                if (createdId) await supabase.from("posts").delete().eq("id", createdId).then(result => {
                    if (result.error) console.error(result.error);
                });
            }
            console.error("Post save failed", error);
            return res.status(500).json({ success: false });
        }
    };
}
