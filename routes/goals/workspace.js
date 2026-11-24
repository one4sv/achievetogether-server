import { authenticateUser } from "../../middleware/token.js";
import { validateGoal, validateGoalStage, goalProgress } from "../../utils/goalWorkspace.js";

import { automaticMode, readActivityProgress } from "../../utils/activityGoalProgress.js";

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
        habitIds.length ? supabase.from("habits").select("id,name").in("id",habitIds) : {data:[],error:null},
        planIds.length ? supabase.from("one_off_plans").select("id,name,plan_date").in("id",planIds) : {data:[],error:null}
    ]);
    if(habits.error || plans.error) throw habits.error || plans.error;
    const progress = automaticMode(goal.progress_mode) ? await readActivityProgress(supabase,goal,habitIds) : {progress:goalProgress(goal,stages.data || [])};
    return {...goal,...progress,
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

const validIds = ids => Array.isArray(ids) && ids.length <= 40 && ids.every(validId);
async function validateLinks(supabase,userId,kind,ids){
    for(const id of ids) if(!await allowOwnTarget(supabase,kind,id,userId)) return false;
    return true;
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
            return res.json({success:true,goals:await Promise.all(goals.map(async g=>{
                if(automaticMode(g.progress_mode)){
                    const {data:links,error}=await supabase.from("at_goal_habit_links").select("habit_id").eq("goal_id",g.id);
                    if(error) throw error;
                    return {...g,...await readActivityProgress(supabase,g,(links || []).map(l=>l.habit_id))};
                }
                return {...g,progress:goalProgress(g,stages.filter(s=>String(s.goal_id)===String(g.id)))};
            }))});
        }catch(error){return fail(res,error);}
    });

    app.post("/goal-workspace",auth,async(req,res)=>{
        if(!req.user?.id) return unauthorized(res);
        const body=req.body && typeof req.body==="object" && !Array.isArray(req.body) ? req.body : {};
        const {stages,habit_id,habit_ids,plan_ids, ...fields}=body;
        const hIds=habit_ids ?? (habit_id===undefined?[]:[habit_id]);
        const pIds=plan_ids ?? [];
        const input=validateGoal(fields);
        if(!input || !validIds(hIds) || !validIds(pIds) || (automaticMode(input.progress_mode) && !hIds.length) ||
           (stages!==undefined && (!Array.isArray(stages) || stages.length>40))) return invalid(res);
        const initialStages=(stages || []).map(stage=>validateGoalStage(stage));
        if(initialStages.some(stage=>!stage)) return invalid(res);
        try {
            if(!await validateLinks(supabase,req.user.id,"habit",hIds) || !await validateLinks(supabase,req.user.id,"plan",pIds)) return missing(res);
            const {data:goal,error}=await supabase.from("at_goals").insert({
                ...input,owner_id:req.user.id,metric_current:input.metric_current ??
                    input.metric_start ?? 0
            }).select("*").single();
            if(error) throw error;
            try {
                if(initialStages.length){
                    const created=await supabase.from("at_goal_stages").insert(initialStages.map((s,i)=>({
                        goal_id:goal.id,title:s.title,weight:s.weight ?? 1,position:i
                    })));
                    if(created.error) throw created.error;
                }
                for(const [kind,ids] of [["habit",hIds],["plan",pIds]]){
                    if(!ids.length) continue;
                    const [,,table,col]=targets[kind];
                    const linked=await supabase.from(table).insert([...new Set(ids.map(Number))].map(id=>({goal_id:goal.id,[col]:id})));
                    if(linked.error) throw linked.error;
                }
            }catch(error){
                await supabase.from("at_goals").delete().eq("id",goal.id).eq("owner_id",req.user.id);
                throw error;
            }
            await event(supabase,goal.id,req.user.id,"created");
            return res.status(201).json({success:true,goal:await detail(supabase,goal)});
        }catch(error){return fail(res,error);}
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
            const {habit_ids,plan_ids,...fields}=req.body || {};
            const input=validateGoal(fields,old);
            if(!input || (habit_ids!==undefined && !validIds(habit_ids)) || (plan_ids!==undefined && !validIds(plan_ids))) return invalid(res);
            if(habit_ids!==undefined && !await validateLinks(supabase,req.user.id,"habit",habit_ids)) return missing(res);
            if(plan_ids!==undefined && !await validateLinks(supabase,req.user.id,"plan",plan_ids)) return missing(res);
            if(automaticMode(input.progress_mode ?? old.progress_mode)){
                if(habit_ids!==undefined && !habit_ids.length) return invalid(res);
                if(habit_ids===undefined){
                    const {data:links,error}=await supabase.from("at_goal_habit_links").select("habit_id").eq("goal_id",old.id);
                    if(error) throw error;
                    if(!links?.length) return invalid(res);
                }
            }
            const {data:goal,error}=await supabase.rpc("at_update_goal_and_links",{
                p_goal_id:old.id,p_owner:req.user.id,p_fields:input,
                p_habit_ids:habit_ids===undefined?null:[...new Set(habit_ids.map(Number))],
                p_plan_ids:plan_ids===undefined?null:[...new Set(plan_ids.map(Number))]
            });
            if(error) throw error;
            await event(supabase,goal.id,req.user.id,"updated",{
                status:goal.status,progress_mode:goal.progress_mode
            });
            return res.json({success:true,goal:await detail(supabase,goal)});
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
            const [,,table,idCol]=targets[kind];
            if(kind==="habit" && automaticMode(goal.progress_mode)){
                const {data:links,error}=await supabase.from(table).select("habit_id").eq("goal_id",goal.id);
                if(error) throw error;
                if((links || []).filter(l=>String(l.habit_id)!==String(req.params.linkId)).length===0) return invalid(res);
            }
            const {error}=await supabase.from(table).delete().eq("goal_id",goal.id)
                .eq(idCol,req.params.linkId);
            if(error) throw error;
            await event(supabase,goal.id,req.user.id,"link_removed",{kind,id:req.params.linkId});
            return res.json({success:true,goal:await detail(supabase,goal)});
        }catch(error){return fail(res,error);}
    });
}
