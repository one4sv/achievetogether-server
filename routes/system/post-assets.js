import { authenticateUser } from "../../middleware/token.js";
import { parseArray, readablePost } from "../../utils/postContent.js";

const acceptedTypes = /^(image\/(png|jpeg|webp|gif|avif)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|ogg|wav)|application\/pdf)$/;

function assetPath(supabase, bucket, file, post) {
    if (!file || typeof file.url !== "string") return null;
    try {
        const probe = new URL(supabase.storage.from(bucket).getPublicUrl("__check__").data.publicUrl);
        const source = new URL(file.url);
        const prefix = probe.pathname.slice(0, -"__check__".length);
        if (source.origin !== probe.origin || !source.pathname.startsWith(prefix) ||
            source.search || source.hash) return null;
        const path = decodeURIComponent(source.pathname.slice(prefix.length));
        if (!path || path.length > 800 || path.split("/").some(part => !part || part === "." || part === "..") ||
            /[\\\u0000-\u001f\u007f?#]/.test(path)) return null;
        if (bucket === "posts" && !path.startsWith(post.user_id + "/" + post.id + "/")) return null;
        if (bucket === "comments" && !path.startsWith("comments/")) return null;
        return path;
    } catch {
        return null;
    }
}

async function deliver(supabase, req, res, bucket, file, post) {
    const path = assetPath(supabase, bucket, file, post);
    if (!path) return res.status(404).end();
    const { data, error } = await supabase.storage.from(bucket).download(path);
    if (error || !data) return res.status(404).end();
    const buffer = Buffer.from(await data.arrayBuffer());
    const type = typeof file.type === "string" && acceptedTypes.test(file.type)
        ? file.type : "application/octet-stream";
    res.set("Content-Type", type);
    res.set("Content-Disposition", type === "application/octet-stream" ? "attachment" : "inline");
    const range = req.get?.("range");
    if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) {
            res.set("Content-Range", "bytes */" + buffer.length);
            return res.status(416).end();
        }
        const start = match[1] ? Number(match[1]) : Math.max(0, buffer.length - Number(match[2]));
        const end = match[1] && match[2] ? Math.min(buffer.length - 1, Number(match[2])) : buffer.length - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
            start > end || start >= buffer.length) {
            res.set("Content-Range", "bytes */" + buffer.length);
            return res.status(416).end();
        }
        res.set("Accept-Ranges", "bytes");
        res.set("Content-Range", "bytes " + start + "-" + end + "/" + buffer.length);
        return res.status(206).send(buffer.subarray(start, end + 1));
    }
    return res.send(buffer);
}

export default function postAssetRoutes(app, supabase) {
    const auth = authenticateUser(supabase);
    const headers = res => {
        res.set("Cache-Control", "private, no-store");
        res.set("X-Content-Type-Options", "nosniff");
        res.set("Referrer-Policy", "no-referrer");
    };
    app.get("/post-asset/:postId/:index", auth, async (req, res) => {
        headers(res);
        const { postId, index } = req.params;
        if (!/^\d+$/.test(postId) || !/^\d+$/.test(index)) return res.status(404).end();
        try {
            const post = await readablePost(supabase, postId, req.user?.id, req.query?.share);
            if (!post) return res.status(404).end();
            const file = parseArray(post.media)[Number(index)];
            return await deliver(supabase, req, res, "posts", file, post);
        } catch (error) {
            console.error("Post media request failed:", error);
            return res.status(500).end();
        }
    });
    app.get("/comment-asset/:commentId/:index", auth, async (req, res) => {
        headers(res);
        const { commentId, index } = req.params;
        if (!/^\d+$/.test(commentId) || !/^\d+$/.test(index)) return res.status(404).end();
        try {
            const { data: comment, error } = await supabase.from("posts_comments")
                .select("id,post_id,files").eq("id", commentId).maybeSingle();
            if (error) throw error;
            if (!comment) return res.status(404).end();
            const post = await readablePost(supabase, comment.post_id, req.user?.id, req.query?.share);
            if (!post) return res.status(404).end();
            const file = parseArray(comment.files)[Number(index)];
            return await deliver(supabase, req, res, "comments", file, post);
        } catch (error) {
            console.error("Comment media request failed:", error);
            return res.status(500).end();
        }
    });
}
