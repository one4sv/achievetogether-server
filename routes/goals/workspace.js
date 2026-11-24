import { authenticateUser } from "../../middleware/token.js";
import { validateGoal, validateGoalStage, goalProgress } from "../../utils/goalWorkspace.js";

import { isAutomaticMode, loadTrackedDays } from "../../utils/goalTracking.js";

const validId = id => /^\d+$/.test(String(id)) && Number.isSafeInteger(Number(id)) && Number(id) > 0;
const targets = {
    habit: ["habits","user_id","at_goal_habit_links","habit_id"],
    plan: ["one_off_plans","owner_id","at_goal_plan_links","plan_id"]
};

function fail(res,error) {
    console.error("Goal workspace:",error?.code || error?.message || error);
    return res.status(500).json({success:false,error:"Ошибка обработки цели"});
}
const invalid = res => res.status(400).json({success:false,error:"Некорректные данные"});
const missing = res => res.status(404).json({success:false,error:"Цель не найдена"});
const unauthorized = res => res.status(401).json({success:false,error:"Требуется авторизация"});

async function owned(supabase,id,userId) {
    if (!validId(id)) return null;
    const {data,error} = await supabase.from("at_goals").select("*").eq("id",id)
        .eq("owner_id",userId).maybeSingle();
    if (error) throw error;
    return data;
}
async function event(supabase,goalId,userId,action,details = null) {
    const {error} = await supabase.from("at_goal_events").insert({
        goal_id:goalId,actor_id:userId,action,details
    });
    if (error) console.error("Goal audit event:",error.code || error.message);
}
async function detail(supabase,goal) {
    const [stages,habitsLinks,plansLinks,events] = await Promise.all([
        supabase.from("at_goal_stages").select("*").eq("goal_id",goal.id)
            .order("position",{ascending:true}).order("id",{ascending:true}),
        supabase.from("at_goal_habit_links").select("habit_id").eq("goal_id",goal.id),
        supabase.from("at_goal_plan_links").select("plan_id").eq("goal_id",goal.id),
        supabase.from("at_goal_events").select("id,action,details,created_at")
            .eq("goal_id",goal.id).order("id",{ascending:false}).limit(30)
    ]);
    for(const r of [stages,habitsLinks,plansLinks,events]) if(r.error) throw r.error;
    const habitIds=(habitsLinks.data || []).map(x=>x.habit_id);
    const planIds=(plansLinks.data || []).map(x=>x.plan_id);
    const [habits,plans]=await Promise.all([
        habitIds.length ? supabase.from("habits").select("id,name").in("id",habitIds).eq("user_id",goal.owner_id) : {data:[],error:null},
        planIds.length ? supabase.from("one_off_plans").select("id,name,plan_date").in("id",planIds).eq("owner_id",goal.owner_id) : {data:[],error:null}
    ]);
    if(habits.error || plans.error) throw habits.error || plans.error;
    const tracked_days=await loadTrackedDays(supabase,goal);
    return {...goal,tracked_days,progress:goalProgress(goal,stages.data || [],tracked_days),
        stages:stages.data || [],habits:habits.data || [],plans:plans.data || [],
        events:events.data || []};
}
async function allowOwnTarget(supabase,kind,targetId,userId) {
    const [table,ownerColumn]=targets[kind];
    const {data,error}=await supabase.from(table).select("id")
        .eq("id",targetId).eq(ownerColumn,userId).maybeSingle();
    if(error) throw error;
    return data;
}

export default function goalWorkspaceRoutes(app,supabase) {
    const auth=authenticateUser(supabase);
    app.get("/goal-workspace",auth,async(req,res)=>{
        if(!req.user?.id) return unauthorized(res);
        try {
            const {data,error}=await supabase.from("at_goals").select("*")
                .eq("owner_id",req.user.id).order("created_at",{ascending:false});
            if(error) throw error;
            const goals=data || [];
            let stages=[];
            if(goals.length){
                const result=await supabase.from("at_goal_stages").select("goal_id,weight,completed_at")
                    .in("goal_id",goals.map(g=>g.id));
                if(result.error) throw result.error;
                stages=result.data || [];
            }
            const result=await Promise.all(goals.map(async g=>{
                const tracked_days=await loadTrackedDays(supabase,g);
                return {...g,tracked_days,progress:goalProgress(g,stages.filter(s=>String(s.goal_id)===String(g.id)),tracked_days)};
            }));
            return res.json({success:true,goals:result});
        }catch(error){return fail(res,error);}
    });

    const parseLinks = (values) => values === undefined ? null :
        Array.isArray(values) && values.length<=100 && values.every(validId) ? [...new Set(values.map(Number))] : false;
    const save = async (req,res,old=null) => {
        const body=req.body && typeof req.body==="object" && !Array.isArray(req.body) ? req.body : {};
        const {stages,habit_id,habit_ids,plan_ids,...fields}=body;
        const input=validateGoal(fields,old);
        const habits=parseLinks(habit_ids===undefined && habit_id!==undefined ? [habit_id] : habit_ids);
        const plans=parseLinks(plan_ids);
        if(!input || habits===false || plans===false ||
            (stages!==undefined && (old || !Array.isArray(stages) || stages.length>40))) return invalid(res);
        const initialStages=(stages || []).map(stage=>validateGoalStage(stage));
        if(initialStages.some(stage=>!stage)) return invalid(res);
        const merged={...old,...input};
        if(isAutomaticMode(merged.progress_mode) && !merged.tracking_habit_id) return invalid(res);
        if(merged.tracking_habit_id && !await allowOwnTarget(supabase,"habit",merged.tracking_habit_id,req.user.id)) return missing(res);
        if(merged.progress_mode==="daily_timer"){
            const {data,error}=await supabase.from("habits_settings").select("metric_type")
                .eq("habit_id",merged.tracking_habit_id).maybeSingle();
            if(error) throw error;
            if(data?.metric_type!=="timer") return invalid(res);
        }
        for(const [kind,ids] of [["habit",habits],["plan",plans]]){
            if(ids===null) continue;
            for(const id of ids) if(!await allowOwnTarget(supabase,kind,id,req.user.id)) return missing(res);
        }
        if(!old) input.metric_current=input.metric_current ?? input.metric_start ?? 0;
        const {data:goal,error}=await supabase.rpc("at_goal_save",{
            p_owner:req.user.id,p_id:old?.id ?? null,p_fields:input,
            p_habits:habits,p_plans:plans,p_stages:old?null:initialStages
        });
        if(error) throw error;
        await event(supabase,goal.id,req.user.id,old?"updated":"created");
        return res.status(old?200:201).json({success:true,goal:await detail(supabase,goal)});
    };

    app.post("/goal-workspace",auth,async(req,res)=>{
        if(!req.user?.id) return unauthorized(res);
        try {return await save(req,res);}catch(error){return fail(res,error);}
    });

    app.get("/goal-workspace/:id",auth,async(req,res)=>{
        if(!req.user?.id) return unauthorized(res);
        try{
            const goal=await owned(supabase,req.params.id,req.user.id);
            if(!goal) return missing(res);
            return res.json({success:true,goal:await detail(supabase,goal)});
        }catch(error){return fail(res,error);}
    });

    app.patch("/goal-workspace/:id",auth,async(req,res)=>{
        if(!req.user?.id) return unauthorized(res);
        try{
            const old=await owned(supabase,req.params.id,req.user.id);
            if(!old) return missing(res);
            return await save(req,res,old);
        }catch(error){return fail(res,error);}
    });

    app.delete("/goal-workspace/:id",auth,async(req,res)=>{
        if(!req.user?.id) return unauthorized(res);
        try{
            const goal=await owned(supabase,req.params.id,req.user.id);
            if(!goal) return missing(res);
            const {error}=await supabase.from("at_goals").delete()
                .eq("id",goal.id).eq("owner_id",req.user.id);
            if(error) throw error;
            return res.json({success:true});
        }catch(error){return fail(res,error);}
    });

    app.post("/goal-workspace/:id/stages",auth,async(req,res)=>{
        if(!req.user?.id) return unauthorized(res);
        const input=validateGoalStage(req.body);
        if(!input) return invalid(res);
        try{
            const goal=await owned(supabase,req.params.id,req.user.id);
            if(!goal) return missing(res);
            const {data:existing,error:readError}=await supabase.from("at_goal_stages")
                .select("position").eq("goal_id",goal.id).order("position",{ascending:false}).limit(1);
            if(readError) throw readError;
            const {error}=await supabase.from("at_goal_stages").insert({
                goal_id:goal.id,title:input.title,weight:input.weight ?? 1,
                position:existing?.length ? Number(existing[0].position)+1 : 0
            });
            if(error) throw error;
            await event(supabase,goal.id,req.user.id,"stage_added");
            return res.json({success:true,goal:await detail(supabase,goal)});
        }catch(error){return fail(res,error);}
    });

    app.patch("/goal-workspace/:id/stages/:stageId",auth,async(req,res)=>{
        if(!req.user?.id) return unauthorized(res);
        const input=validateGoalStage(req.body,false);
        if(!validId(req.params.stageId) || !input) return invalid(res);
        try{
            const goal=await owned(supabase,req.params.id,req.user.id);
            if(!goal) return missing(res);
            const {data:stage,error:readError}=await supabase.from("at_goal_stages")
                .select("*").eq("goal_id",goal.id).eq("id",req.params.stageId).maybeSingle();
            if(readError) throw readError;
            if(!stage) return missing(res);
            const {completed,...rest}=input;
            if(completed!==undefined) rest.completed_at=completed ? stage.completed_at || new Date().toISOString() : null;
            const {error}=await supabase.from("at_goal_stages").update(rest)
                .eq("goal_id",goal.id).eq("id",stage.id);
            if(error) throw error;
            await event(supabase,goal.id,req.user.id,"stage_updated",{id:stage.id});
            return res.json({success:true,goal:await detail(supabase,goal)});
        }catch(error){return fail(res,error);}
    });

    app.delete("/goal-workspace/:id/stages/:stageId",auth,async(req,res)=>{
        if(!req.user?.id) return unauthorized(res);
        if(!validId(req.params.stageId)) return invalid(res);
        try{
            const goal=await owned(supabase,req.params.id,req.user.id);
            if(!goal) return missing(res);
            const {data:existing,error:readError}=await supabase.from("at_goal_stages")
                .select("id").eq("goal_id",goal.id).eq("id",req.params.stageId).maybeSingle();
            if(readError) throw readError;
            if(!existing) return missing(res);
            const {error}=await supabase.from("at_goal_stages").delete()
                .eq("goal_id",goal.id).eq("id",existing.id);
            if(error) throw error;
            await event(supabase,goal.id,req.user.id,"stage_deleted");
            return res.json({success:true,goal:await detail(supabase,goal)});
        }catch(error){return fail(res,error);}
    });

    app.post("/goal-workspace/:id/links",auth,async(req,res)=>{
        if(!req.user?.id) return unauthorized(res);
        const body=req.body;
        if(!body || typeof body!=="object" || Array.isArray(body) ||
            Object.keys(body).some(key=>!["kind","id"].includes(key)) ||
            !targets[body.kind] || !validId(body.id)) return invalid(res);
        try{
            const goal=await owned(supabase,req.params.id,req.user.id);
            if(!goal) return missing(res);
            const target=await allowOwnTarget(supabase,body.kind,body.id,req.user.id);
            if(!target) return missing(res);
            const [,,table,idCol]=targets[body.kind];
            const {error}=await supabase.from(table).upsert({
                goal_id:goal.id,[idCol]:target.id
            },{onConflict:"goal_id,"+idCol});
            if(error) throw error;
            await event(supabase,goal.id,req.user.id,"link_added",{kind:body.kind,id:target.id});
            return res.json({success:true,goal:await detail(supabase,goal)});
        }catch(error){return fail(res,error);}
    });

    app.delete("/goal-workspace/:id/links/:kind/:linkId",auth,async(req,res)=>{
        if(!req.user?.id) return unauthorized(res);
        const kind=req.params.kind;
        if(!targets[kind] || !validId(req.params.linkId)) return invalid(res);
        try{
            const goal=await owned(supabase,req.params.id,req.user.id);
            if(!goal) return missing(res);
            if(kind==="habit" && isAutomaticMode(goal.progress_mode) &&
                String(goal.tracking_habit_id)===String(req.params.linkId)) return invalid(res);
            const [,,table,idCol]=targets[kind];
            const {error}=await supabase.from(table).delete().eq("goal_id",goal.id)
                .eq(idCol,req.params.linkId);
            if(error) throw error;
            await event(supabase,goal.id,req.user.id,"link_removed",{kind,id:req.params.linkId});
            return res.json({success:true,goal:await detail(supabase,goal)});
        }catch(error){return fail(res,error);}
    });
}
