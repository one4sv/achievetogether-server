import { authenticateUser } from "../../middleware/token.js";
import { normalizeGoalInput, normalizeMilestone, goalProgress } from "../../utils/goalProgress.js";

const goodId = id => /^\d+$/.test(String(id)) && Number.isSafeInteger(Number(id)) && Number(id) > 0;
const tables = { habit:"goal_habit_links", plan:"goal_plan_links" };
const targets = { habit:["habits", "user_id", "habit_id"], plan:["one_off_plans", "owner_id", "plan_id"] };

function unauthenticated(res) {
    return res.status(401).json({ success:false, error:"Требуется авторизация" });
}
function missing(res) {
    return res.status(404).json({ success:false, error:"Цель не найдена" });
}
function invalid(res) {
    return res.status(400).json({ success:false, error:"Некорректные данные цели" });
}
function failed(res, error) {
    console.error("Goals:", error?.code || error?.message || error);
    return res.status(500).json({ success:false, error:"Ошибка обработки цели" });
}

async function owned(supabase, id, ownerId) {
    if (!goodId(id)) return null;
    const { data, error } = await supabase.from("goals").select("*")
        .eq("id", id).eq("owner_id", ownerId).maybeSingle();
    if (error) throw error;
    return data;
}
async function logEvent(supabase, goalId, actorId, action, oldValue = null, newValue = null) {
    const { error } = await supabase.from("goal_progress_events").insert({
        goal_id:goalId, actor_id:actorId, action, old_value:oldValue, new_value:newValue
    });
    if (error) console.error("Goal audit:", error?.code || error?.message);
}
async function detail(supabase, goal) {
    const id = goal.id;
    const [stages, habitLinks, planLinks, events] = await Promise.all([
        supabase.from("goal_milestones").select("*").eq("goal_id", id).order("position", { ascending:true }).order("id", { ascending:true }),
        supabase.from("goal_habit_links").select("habit_id").eq("goal_id", id),
        supabase.from("goal_plan_links").select("plan_id").eq("goal_id", id),
        supabase.from("goal_progress_events").select("id,action,created_at,old_value,new_value")
            .eq("goal_id", id).order("id", { ascending:false }).limit(30)
    ]);
    for (const query of [stages, habitLinks, planLinks, events]) if (query.error) throw query.error;
    const habitIds = (habitLinks.data || []).map(item => item.habit_id);
    const planIds = (planLinks.data || []).map(item => item.plan_id);
    const [habits, plans] = await Promise.all([
        habitIds.length ? supabase.from("habits").select("id,name").in("id", habitIds) : { data:[], error:null },
        planIds.length ? supabase.from("one_off_plans").select("id,name,plan_date").in("id", planIds) : { data:[], error:null }
    ]);
    if (habits.error || plans.error) throw habits.error || plans.error;
    const stagesData = stages.data || [];
    return { ...goal, progress:goalProgress(goal, stagesData), milestones:stagesData,
        habits:habits.data || [], plans:plans.data || [], events:events.data || [] };
}

export default function goalsRoutes(app, supabase) {
    const auth = authenticateUser(supabase);

    app.get("/goals", auth, async (req, res) => {
        if (!req.user?.id) return unauthenticated(res);
        try {
            const { data:goals, error } = await supabase.from("goals").select("*")
                .eq("owner_id", req.user.id).order("created_at", { ascending:false });
            if (error) throw error;
            const ids = (goals || []).map(goal => goal.id);
            let stages = [];
            if (ids.length) {
                const result = await supabase.from("goal_milestones").select("goal_id,weight,completed_at").in("goal_id", ids);
                if (result.error) throw result.error;
                stages = result.data || [];
            }
            res.json({ success:true, goals:(goals || []).map(goal => ({
                ...goal, progress:goalProgress(goal, stages.filter(stage => String(stage.goal_id) === String(goal.id)))
            })) });
        } catch (error) { failed(res,error); }
    });

    app.post("/goals", auth, async (req, res) => {
        if (!req.user?.id) return unauthenticated(res);
        const { milestones, ...fields } = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
        const input = normalizeGoalInput(fields);
        if (!input || (milestones !== undefined && (!Array.isArray(milestones) || milestones.length > 40))) return invalid(res);
        const stages = (milestones || []).map(item => normalizeMilestone(item));
        if (stages.some(item => !item || "completed" in item)) return invalid(res);
        try {
            const { data:goal, error } = await supabase.from("goals")
                .insert({ ...input, owner_id:req.user.id }).select("*").single();
            if (error) throw error;
            if (stages.length) {
                const inserted = await supabase.from("goal_milestones").insert(stages.map((stage, index) => ({
                    goal_id:goal.id, title:stage.title, weight:stage.weight ?? 1, position:index
                })));
                if (inserted.error) {
                    await supabase.from("goals").delete().eq("id",goal.id).eq("owner_id",req.user.id);
                    throw inserted.error;
                }
            }
            await logEvent(supabase, goal.id, req.user.id, "created", null, { name:goal.name });
            res.status(201).json({ success:true, goal:await detail(supabase,goal) });
        } catch (error) { failed(res,error); }
    });

    app.get("/goals/:id", auth, async (req, res) => {
        if (!req.user?.id) return unauthenticated(res);
        try {
            const goal = await owned(supabase,req.params.id,req.user.id);
            if (!goal) return missing(res);
            res.json({ success:true, goal:await detail(supabase,goal) });
        } catch (error) { failed(res,error); }
    });

    app.patch("/goals/:id", auth, async (req, res) => {
        if (!req.user?.id) return unauthenticated(res);
        try {
            const old = await owned(supabase,req.params.id,req.user.id);
            if (!old) return missing(res);
            const input = normalizeGoalInput(req.body,old);
            if (!input) return invalid(res);
            const { data:goal, error } = await supabase.from("goals").update({
                ...input, updated_at:new Date().toISOString()
            }).eq("id", old.id).eq("owner_id", req.user.id).select("*").single();
            if (error) throw error;
            await logEvent(supabase,goal.id,req.user.id,
                "updated", { status:old.status, progress_mode:old.progress_mode, metric_current:old.metric_current,
                    manual_progress:old.manual_progress },
                { status:goal.status, progress_mode:goal.progress_mode, metric_current:goal.metric_current,
                    manual_progress:goal.manual_progress });
            res.json({ success:true, goal:await detail(supabase,goal) });
        } catch (error) { failed(res,error); }
    });

    app.delete("/goals/:id", auth, async (req, res) => {
        if (!req.user?.id) return unauthenticated(res);
        try {
            const goal = await owned(supabase,req.params.id,req.user.id);
            if (!goal) return missing(res);
            const { error } = await supabase.from("goals").delete()
                .eq("id",goal.id).eq("owner_id",req.user.id);
            if (error) throw error;
            res.json({ success:true });
        } catch (error) { failed(res,error); }
    });

    app.post("/goals/:id/milestones", auth, async (req, res) => {
        if (!req.user?.id) return unauthenticated(res);
        const input = normalizeMilestone(req.body);
        if (!input || "completed" in input) return invalid(res);
        try {
            const goal = await owned(supabase,req.params.id,req.user.id);
            if (!goal) return missing(res);
            const { data:existing, error:readError } = await supabase.from("goal_milestones")
                .select("position").eq("goal_id",goal.id).order("position", {ascending:false}).limit(1);
            if (readError) throw readError;
            const { error } = await supabase.from("goal_milestones").insert({
                goal_id:goal.id, title:input.title, weight:input.weight ?? 1,
                position:existing?.length ? Number(existing[0].position) + 1 : 0
            });
            if (error) throw error;
            await logEvent(supabase,goal.id,req.user.id,"milestone_added");
            res.json({ success:true, goal:await detail(supabase,goal) });
        } catch (error) { failed(res,error); }
    });

    app.patch("/goals/:id/milestones/:milestoneId", auth, async (req, res) => {
        if (!req.user?.id) return unauthenticated(res);
        const input = normalizeMilestone(req.body,true);
        if (!input || !goodId(req.params.milestoneId)) return invalid(res);
        try {
            const goal = await owned(supabase,req.params.id,req.user.id);
            if (!goal) return missing(res);
            const { data:old, error:readError } = await supabase.from("goal_milestones")
                .select("*").eq("goal_id",goal.id).eq("id",req.params.milestoneId).maybeSingle();
            if (readError) throw readError;
            if (!old) return missing(res);
            const { completed, ...rest } = input;
            const changes = { ...rest };
            if (completed !== undefined) {
                changes.completed_at = completed ? old.completed_at || new Date().toISOString() : null;
                changes.completed_by = completed ? req.user.id : null;
            }
            const { error } = await supabase.from("goal_milestones").update(changes)
                .eq("goal_id",goal.id).eq("id",old.id);
            if (error) throw error;
            await logEvent(supabase,goal.id,req.user.id,"milestone_updated",
                { id:old.id, completed:Boolean(old.completed_at), weight:old.weight },
                { id:old.id, completed:completed ?? Boolean(old.completed_at), weight:changes.weight ?? old.weight });
            res.json({ success:true, goal:await detail(supabase,goal) });
        } catch (error) { failed(res,error); }
    });

    app.delete("/goals/:id/milestones/:milestoneId", auth, async (req, res) => {
        if (!req.user?.id) return unauthenticated(res);
        try {
            const goal = await owned(supabase,req.params.id,req.user.id);
            if (!goal) return missing(res);
            if (!goodId(req.params.milestoneId)) return invalid(res);
            const { error } = await supabase.from("goal_milestones").delete()
                .eq("goal_id",goal.id).eq("id",req.params.milestoneId);
            if (error) throw error;
            await logEvent(supabase,goal.id,req.user.id,"milestone_removed",{ id:req.params.milestoneId });
            res.json({ success:true, goal:await detail(supabase,goal) });
        } catch (error) { failed(res,error); }
    });

    app.post("/goals/:id/links", auth, async (req, res) => {
        if (!req.user?.id) return unauthenticated(res);
        const kind = req.body?.kind;
        const linkedId = req.body?.id;
        if (!targets[kind] || !goodId(linkedId) || Object.keys(req.body || {}).some(key => !["kind","id"].includes(key))) return invalid(res);
        try {
            const goal = await owned(supabase,req.params.id,req.user.id);
            if (!goal) return missing(res);
            const [targetTable, ownerColumn, linkColumn] = targets[kind];
            const { data:target, error:readError } = await supabase.from(targetTable)
                .select("id").eq("id",linkedId).eq(ownerColumn,req.user.id).maybeSingle();
            if (readError) throw readError;
            if (!target) return missing(res);
            const { error } = await supabase.from(tables[kind])
                .upsert({ goal_id:goal.id, [linkColumn]:target.id }, { onConflict:"goal_id," + linkColumn });
            if (error) throw error;
            await logEvent(supabase,goal.id,req.user.id,"link_added",null,{ kind, id:target.id });
            res.json({ success:true, goal:await detail(supabase,goal) });
        } catch (error) { failed(res,error); }
    });

    app.delete("/goals/:id/links/:kind/:linkedId", auth, async (req, res) => {
        if (!req.user?.id) return unauthenticated(res);
        const kind = req.params.kind;
        if (!targets[kind] || !goodId(req.params.linkedId)) return invalid(res);
        try {
            const goal = await owned(supabase,req.params.id,req.user.id);
            if (!goal) return missing(res);
            const { error } = await supabase.from(tables[kind]).delete().eq("goal_id",goal.id)
                .eq(targets[kind][2],req.params.linkedId);
            if (error) throw error;
            await logEvent(supabase,goal.id,req.user.id,"link_removed",{ kind, id:req.params.linkedId });
            res.json({ success:true, goal:await detail(supabase,goal) });
        } catch (error) { failed(res,error); }
    });
}
