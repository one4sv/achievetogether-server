import { authenticateUser } from "../../middleware/token.js";
import { canAccessMessage } from "../../utils/messageAccess.js";

const supportedBuckets = new Set(["media", "bgs"]);

export function privateAssetUrl(value) {
    if (typeof value !== "string" || !process.env.SUPABASE_URL) return value;
    try {
        const original = new URL(value);
        if (original.origin !== new URL(process.env.SUPABASE_URL).origin) return value;
        const found = /^\/storage\/v1\/object\/public\/(media|bgs)\/(.+)$/.exec(original.pathname);
        if (!found) return value;
        const segments = found[2].split("/").map(segment => encodeURIComponent(decodeURIComponent(segment)));
        if (!segments.length || segments.some(segment => !segment)) return value;
        return "/api/private-asset/" + found[1] + "/" + segments.join("/");
    } catch {
        return value;
    }
}

export function originalAssetUrl(value, supabase) {
    if (typeof value !== "string") return value;
    const found = /^\/api\/private-asset\/(media|bgs)\/(.+)$/.exec(value);
    if (!found) return value;
    try {
        const path = found[2].split("/").map(segment => decodeURIComponent(segment)).join("/");
        if (!validPath(path)) return value;
        return supabase.storage.from(found[1]).getPublicUrl(path).data.publicUrl;
    } catch {
        return value;
    }
}

export function rewritePrivateAssets(payload) {
    if (typeof payload === "string") return privateAssetUrl(payload);
    if (Array.isArray(payload)) return payload.map(rewritePrivateAssets);
    if (payload && typeof payload === "object") {
        return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, rewritePrivateAssets(value)]));
    }
    return payload;
}

function validPath(path) {
    return typeof path === "string" && path.length > 0 && path.length <= 300 &&
        !path.split("/").some(segment => !segment || segment === "." || segment === "..") &&
        /^[a-zA-Z0-9_./-]+$/.test(path);
}

export async function canDownloadMedia(supabase, path, userId) {
    const publicUrl = supabase.storage.from("media").getPublicUrl(path).data.publicUrl;
    const { data: files, error } = await supabase.from("message_files")
        .select("id,message_id,file_type,file_name").eq("file_url", publicUrl).limit(30);
    if (error) throw error;
    if (!files?.length) return null;

    for (const file of files) {
        const { data: original, error: sourceError } = await supabase.from("messages")
            .select("id,chat_id,hidden").eq("id", file.message_id).maybeSingle();
        if (sourceError) throw sourceError;
        if (!original) continue;
        if (await canAccessMessage(supabase, original, userId)) return file;

        const { data: forwards, error: forwardError } = await supabase.from("messages")
            .select("id,chat_id,hidden").eq("redirected_id", original.id).limit(200);
        if (forwardError) throw forwardError;
        for (const forward of forwards || []) {
            if (await canAccessMessage(supabase, forward, userId)) return file;
        }
    }
    return null;
}

export async function canDownloadBackground(supabase, path, userId) {
    const { data, error } = await supabase.from("settings")
        .select("bg_gallery").eq("user_id", userId).maybeSingle();
    if (error) throw error;
    return (Array.isArray(data?.bg_gallery) && data.bg_gallery.some(item => item?.path === path))
        ? { file_type: "image/*", file_name: "background" } : null;
}

export default function privateAssetRoutes(app, supabase) {
    const auth = authenticateUser(supabase);
    app.use((req, res, next) => {
        const original = res.json.bind(res);
        res.json = body => original(rewritePrivateAssets(body));
        next();
    });
    app.get("/private-asset/:bucket/*path", auth, async (req, res) => {
        res.set("Cache-Control", "private, no-store");
        res.set("X-Content-Type-Options", "nosniff");
        if (!req.user?.id) return res.status(401).end();
        const bucket = req.params.bucket;
        const path = Array.isArray(req.params.path) ? req.params.path.join("/") : req.params.path;
        if (!supportedBuckets.has(bucket) || !validPath(path)) return res.status(404).end();
        try {
            const allowed = bucket === "media" ?
                await canDownloadMedia(supabase, path, req.user.id) :
                await canDownloadBackground(supabase, path, req.user.id);
            if (!allowed) return res.status(403).end();
            const { data, error } = await supabase.storage.from(bucket).download(path);
            if (error || !data) return res.status(404).end();
            const buffer = Buffer.from(await data.arrayBuffer());
            const type = bucket === "bgs" ?
                (data.type?.startsWith("image/") ? data.type : "application/octet-stream") :
                (allowed.file_type && /^(image\/(png|jpeg|webp|gif|avif)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|ogg|wav)|application\/pdf)$/.test(allowed.file_type) ?
                    allowed.file_type : "application/octet-stream");
            res.set("Content-Type", type);
            res.set("Content-Disposition", type === "application/octet-stream" ? "attachment" : "inline");
            const range = req.get("range");
            if (range) {
                const match = /^bytes=(\d*)-(\d*)$/.exec(range);
                if (!match || (!match[1] && !match[2])) {
                    res.set("Content-Range", `bytes */${buffer.length}`);
                    return res.status(416).end();
                }
                const suffix = !match[1];
                const start = suffix ? Math.max(0, buffer.length - Number(match[2])) : Number(match[1]);
                const end = suffix ? buffer.length - 1 : match[2] ? Math.min(buffer.length - 1, Number(match[2])) : buffer.length - 1;
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= buffer.length) {
                    res.set("Content-Range", `bytes */${buffer.length}`);
                    return res.status(416).end();
                }
                res.set("Accept-Ranges", "bytes");
                res.set("Content-Range", `bytes ${start}-${end}/${buffer.length}`);
                return res.status(206).send(buffer.subarray(start, end + 1));
            }
            return res.send(buffer);
        } catch {
            return res.status(500).end();
        }
    });
}
