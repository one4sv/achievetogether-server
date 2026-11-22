import { authenticateUser } from "../../middleware/token.js";
import { sharedEntityPreview } from "../../utils/sharedEntity.js";

export default function sharedEntityRoutes(app,supabase) {
    app.get("/chat/entity/:kind/:id",authenticateUser(supabase),async(req,res) => {
        try {
            const item = await sharedEntityPreview(supabase,req.params.kind,req.params.id,req.user?.id);
            if (!item) return res.status(404).json({success:false});
            res.set("Cache-Control","no-store");
            return res.json({success:true,item});
        } catch (error) {
            console.error("Shared entity preview error:",error?.message);
            return res.status(500).json({success:false});
        }
    });
}
