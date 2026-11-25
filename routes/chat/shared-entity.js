import { authenticateUser } from "../../middleware/token.js";
import { sharedEntityPreview } from "../../utils/sharedEntity.js";

export default function sharedEntityRoutes(app,supabase) {
    app.get("/chat/entity/:kind/:id",authenticateUser(supabase),async(req,res) => {
        try {
            if (!req.user?.id) return res.sendStatus(401);
            let id = req.params.id;
            // Profile URLs use a nickname, whereas shared user cards use UUIDs.
            if (req.params.kind === "user" && id.startsWith("nick:")) {
                const nick = id.slice(5);
                if (!nick || nick.length > 64 || /[\/\\\s]/.test(nick)) return res.sendStatus(400);
                const {data, error} = await supabase.from("users").select("id").eq("nick",nick).maybeSingle();
                if (error) throw error;
                if (!data) return res.status(404).json({success:false});
                id = data.id;
            }
            const item = await sharedEntityPreview(supabase,req.params.kind,id,req.user.id);
            if (!item) return res.status(404).json({success:false});
            res.set("Cache-Control","no-store");
            return res.json({success:true,item});
        } catch (error) {
            console.error("Shared entity preview error:",error?.message);
            return res.status(500).json({success:false});
        }
    });
}
