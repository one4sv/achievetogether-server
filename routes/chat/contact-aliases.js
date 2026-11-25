import { authenticateUser } from "../../middleware/token.js";

const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export default function contactAliasRoutes(app, supabase) {
    app.get("/contact-aliases", authenticateUser(supabase), async (req, res) => {
        const owner = req.user?.id;
        if (!owner) return res.sendStatus(401);
        res.set("Cache-Control", "private, no-store");
        try {
            const aliases = [];
            let after;
            for (;;) {
                let query = supabase.from("contact_aliases").select("contact_id,alias")
                    .eq("owner_id", owner).order("contact_id").limit(500);
                if (after) query = query.gt("contact_id", after);
                const { data, error } = await query;
                if (error) throw error;
                aliases.push(...(data || []));
                if (!data || data.length < 500) break;
                after = data[data.length - 1].contact_id;
            }
            return res.json({ success: true, owner_id: owner, aliases });
        } catch (error) {
            console.error("Contact aliases read", error?.code);
            return res.sendStatus(500);
        }
    });

    app.put("/contact-aliases/:id", authenticateUser(supabase), async (req, res) => {
        const owner = req.user?.id;
        if (!owner) return res.sendStatus(401);
        const contact = req.params.id;
        const body = req.body;
        if (!uuid(contact) || contact.toLowerCase() === owner.toLowerCase() ||
            !body || body.owner_id !== owner || typeof body.alias !== "string" ||
            Array.from(body.alias.trim()).length > 40 ||
            (body.import_local !== undefined && typeof body.import_local !== "boolean")) return res.sendStatus(400);
        res.set("Cache-Control", "private, no-store");
        try {
            const { data: target, error: targetError } = await supabase.from("users")
                .select("id").eq("id", contact).maybeSingle();
            if (targetError) throw targetError;
            if (!target) return res.sendStatus(404);
            const alias = body.alias.trim();
            const { error } = await supabase.from("contact_aliases").upsert({
                owner_id: owner, contact_id: target.id, alias
            }, { onConflict: "owner_id,contact_id", ignoreDuplicates: body.import_local === true });
            if (error) throw error;
            const { data, error: readError } = await supabase.from("contact_aliases")
                .select("alias").eq("owner_id", owner).eq("contact_id", target.id).single();
            if (readError) throw readError;
            return res.json({ success: true, owner_id: owner, contact_id: target.id, alias: data.alias });
        } catch (error) {
            console.error("Contact alias write", error?.code);
            return res.sendStatus(500);
        }
    });
}
