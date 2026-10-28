import { visiblePosts, signedMedia } from "../../utils/postContent.js";
import { authenticateUser } from "../../middleware/token.js";
const array = value => {
    try {
        const parsed = typeof value === "string" ? JSON.parse(value) : value;
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};
export default function postRoute(app, supabase) {
    app.get(
        "/post/:id",
        authenticateUser(supabase),
        async (req, res, next) => {
            res.set("Cache-Control", "no-store");
            if (!/^\d+$/.test(req.params.id)) return res.status(404).json({
                success: false
            });
            try {
                const {
                    data: post,
                    error
                } = await supabase.from("posts").select("*").eq("id", req.params.id).maybeSingle();
                if (error) throw error;
                if (!post) return res.status(404).json({
                    success: false
                });
                const {
                    data: settings,
                    error: settingsError
                } = await supabase.from("settings").select("private").eq("user_id", post.user_id).maybeSingle();
                if (settingsError) throw settingsError;
                if (!(await visiblePosts(supabase, [post], req.user?.id)).length) {
                    return res.status(404).json({ success: false });
                }
                const {
                    data: user,
                    error: userError
                } = await supabase.from("users").select("id,nick,username,avatar_url").eq("id", post.user_id).maybeSingle();
                if (userError) throw userError;
                if (!user) return res.status(404).json({
                    success: false
                });
                // Habit content has independent privacy. Do not expose it through a post.
                let habit = null;
                if (post.habit_id && (req.user?.id === post.user_id || settings?.private?.habits === "all")) {
                    const result = await supabase.from("habits").select("*").eq("id", post.habit_id).eq("user_id", post.user_id).maybeSingle();
                    if (result.error) throw result.error;
                    habit = result.data;
                }
                res.json(
                    {
                        success: true,
                        post: {
                            id: post.id,
                            user,
                            text: post.text ?? "",
                            content: post.content ?? null,
                            visibility: post.visibility ?? "inherit",
                            media: await signedMedia(supabase, post.media, "posts"),
                            likes: array(post.likes),
                            habit,
                            created_at: post.created_at,
                            comments_count: post.comments_count ?? 0
                        }
                    }
                );
            } catch (error) {
                next(error);
            }
        }
    );
}
