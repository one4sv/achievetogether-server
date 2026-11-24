import { authenticateUser } from "../../middleware/token.js";
import { validateGoal, validateGoalStage, goalProgress, validGoalDate } from "../../utils/goalWorkspace.js";

import { automaticMode, readActivityProgress, ownerGoalZone, goalDay, dayStart, requiredHabitMetric } from "../../utils/activityGoalProgress.js";

import { advanceGoalPeriod, prepareOwnedGoal, repeating } from "../../utils/goalPeriods.js";

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
    return prepareOwnedGoal(supabase,data);
}
async function event(supabase,goalId,userId,action,details = null) {
    const {error} = await supabase.from("at_goal_events").insert({
        goal_id:goalId,actor_id:userId,action,details
    });
    if (error) console.error("Goal audit event:",error.code || error.message);
}
export async function calculateGoalProgress(supabase,goal,habitIds,stages,zone){
    if(repeating(goal)){
        zone=await ownerGoalZone(supabase,goal.owner_id);
        ({goal,stages}=await advanceGoalPeriod(supabase,goal,habitIds,stages,zone));
    }
    const progress=automaticMode(goal.progress_mode)?await readActivityProgress(supabase,goal,habitIds,zone):{progress:goalProgress(goal,stages)};
    let recorded=goal;
    if(goal.last_progress!==undefined && (Number(goal.last_progress)!==progress.progress || goal.last_progress===null ||
        (goal.auto_complete && goal.status==="active" && progress.progress>=100) ||
        (goal.auto_completed && goal.status==="completed" && progress.progress<100))){
        const args={p_goal_id:goal.id,p_owner:goal.owner_id,p_progress:progress.progress};
        const {data,error}=repeating(goal)?await supabase.rpc("at_record_goal_period_progress",{...args,p_expected_start:goal.repeat_period_start}):await supabase.rpc("at_record_goal_progress",args);
        if(error) throw error;
        recorded=(Array.isArray(data)?data[0]:data) || goal;
    }
    return {...recorded,...progress};
}
async function detail(supabase,goal,requestedZone) {
    goal=await prepareOwnedGoal(supabase,goal,requestedZone);
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
    const zone=await ownerGoalZone(supabase,goal.owner_id,requestedZone);
    const progress=await calculateGoalProgress(supabase,goal,habitIds,stages.data || [],zone);
    const latest=await supabase.from("at_goal_events").select("id,action,details,created_at").eq("goal_id",goal.id).order("id",{ascending:false}).limit(30);
    if(latest.error)throw latest.error;
    return {...progress,
        stages:stages.data || [],habits:habits.data || [],plans:plans.data || [],
        events:latest.data || []};
}
async function allowOwnTarget(supabase,kind,targetId,userId,existingGoalId=null) {
    const [table,ownerColumn]=targets[kind];
    const {data,error}=await supabase.from(table).select(kind==="habit"?"id,ongoing":"id,status,plan_date,start_time,end_time")
        .eq("id",targetId).eq(ownerColumn,userId).maybeSingle();
    if(error) throw error;
    if(!data) return null;
    const now=new Date();
    const zone=await ownerGoalZone(supabase,userId);
    const day=goalDay(now,zone);
    const clock=now.toLocaleTimeString("en-GB",{timeZone:zone,hourCycle:"h23"});
    const cutoff=data.end_time || data.start_time;
    const active=kind==="habit"?data.ongoing===true:data.status==="upcoming" &&
        (data.plan_date>day || (data.plan_date===day && (!cutoff || cutoff.slice(0,5)>clock.slice(0,5))));
    if(active) return data;
    if(existingGoalId){
        const [,,linkTable,col]=targets[kind];
        const linked=await supabase.from(linkTable).select(col).eq("goal_id",existingGoalId).eq(col,targetId).maybeSingle();
        if(linked.error) throw linked.error;
        if(linked.data) return data;
    }
    return null;
}

const validIds = ids => Array.isArray(ids) && ids.length <= 40 && ids.every(validId);
async function validateHabitMetric(supabase,mode,ids){
    const required=requiredHabitMetric(mode);
    if(!required) return true;
    if(!ids.length) return false;
    const {data,error}=await supabase.from("habits_settings").select("habit_id,metric_type").in("habit_id",ids);
    if(error) throw error;
    return ids.every(id=>(data || []).some(s=>String(s.habit_id)===String(id) && s.metric_type===required));
}
async function validateLinks(supabase,userId,kind,ids,existingGoalId=null){
    for(const id of ids) if(!await allowOwnTarget(supabase,kind,id,userId,existingGoalId)) return false;
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
                const result=await supabase.from("at_goal_stages").select("id,goal_id,title,position,weight,completion_percent,completed_at")
                    .in("goal_id",goals.map(g=>g.id));
                if(result.error) throw result.error;
                stages=result.data || [];
            }
            const zone=goals.length?await ownerGoalZone(supabase,req.user.id,req.query?.timezone):"UTC";
            const {data:links,error:linksError}=goals.length?await supabase.from("at_goal_habit_links").select("goal_id,habit_id").in("goal_id",goals.map(g=>g.id)):{data:[],error:null};
            if(linksError) throw linksError;
            const results=[];
            for(let i=0;i<goals.length;i+=8){
                results.push(...await Promise.all(goals.slice(i,i+8).map(async g=>{
                    const habit_ids=(links || []).filter(l=>String(l.goal_id)===String(g.id)).map(l=>l.habit_id);
                    const ownStages=stages.filter(s=>String(s.goal_id)===String(g.id));
                    const result=await calculateGoalProgress(supabase,g,habit_ids,ownStages,zone);
                    const recentStages=ownStages.filter(s=>s.completed_at && (!result.repeat_period_start || goalDay(s.completed_at,zone)>=result.repeat_period_start)).sort((a,b)=>String(b.completed_at).localeCompare(String(a.completed_at))).slice(0,2);
                    return {...result,habit_ids,recent_stages:recentStages};
                })));
            }
            return res.json({success:true,goals:results});
        }catch(error){return fail(res,error);}
    });

    app.get("/goal-workspace/day/:date",auth,async(req,res)=>{
        if(!req.user?.id)return unauthorized(res);
        const date=req.params.date;
        if(!date || !validGoalDate(date))return invalid(res);
        try{
            const zone=await ownerGoalZone(supabase,req.user.id,req.query?.timezone);
            const next=new Date(Date.parse(date+"T00:00:00Z")+86400000).toISOString().slice(0,10);
            const from=new Date(dayStart(date,zone)).toISOString(),to=new Date(dayStart(next,zone)).toISOString();
            const {data:goals,error}=await supabase.from("at_goals").select("id,completed_at").eq("owner_id",req.user.id);
            if(error)throw error;
            const ids=(goals || []).map(g=>g.id);
            const done=new Set((goals || []).filter(g=>g.completed_at && g.completed_at>=from && g.completed_at<to).map(g=>String(g.id)));
            if(ids.length){
                for(let offset=0;;offset+=500){
                    const {data,error}=await supabase.from("at_goal_events").select("goal_id,action,details,created_at").in("goal_id",ids).in("action",["progress_changed","updated","auto_status"]).gte("created_at",from).lt("created_at",to).order("id").range(offset,offset+499);
                    if(error)throw error;
                    for(const e of data || [])if((e.action==="progress_changed" && Number(e.details?.to)>=100 && (e.details?.from==null || Number(e.details.from)<100)) || (["updated","auto_status"].includes(e.action) && e.details?.status==="completed"))done.add(String(e.goal_id));
                    if(!data || data.length<500)break;
                }
            }
            return res.json({success:true,completed_ids:[...done]});
        }catch(error){return fail(res,error);}
    });

    app.get("/goal-workspace/activity/:habitId/records",auth,async(req,res)=>{
        if(!req.user?.id)return unauthorized(res);
        if(!validId(req.params.habitId))return invalid(res);
        try{
            const {data:links,error}=await supabase.from("at_goal_habit_links").select("goal_id").eq("habit_id",req.params.habitId);
            if(error)throw error;
            if(!links?.length)return res.json({success:true,records:{}});
            const {data:goals,error:goalError}=await supabase.from("at_goals").select("id,progress_mode,repeat_period_start").eq("owner_id",req.user.id).in("id",links.map(l=>l.goal_id));
            if(goalError)throw goalError;
            const records={};
            const zone=await ownerGoalZone(supabase,req.user.id,req.query?.timezone);
            await Promise.all((goals || []).filter(g=>["manual","metric","combined"].includes(g.progress_mode)).map(async g=>{
                let query=supabase.from("at_goal_events").select("id,action,details,created_at").eq("goal_id",g.id).eq("action","progress_changed");
                if(g.repeat_period_start)query=query.gte("created_at",new Date(dayStart(g.repeat_period_start,zone)).toISOString());
                const {data,error}=await query.order("id",{ascending:false}).limit(2);
                if(error)throw error;
                records[g.id]=(data || []).map(e=>({kind:"progress",id:String(e.id),date:e.created_at,value:e.details?.to}));
            }));
            return res.json({success:true,records});
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
            if(!await validateHabitMetric(supabase,input.progress_mode,hIds)) return invalid(res);
            const {data:goal,error}=await supabase.from("at_goals").insert({
                ...input,owner_id:req.user.id,metric_current:input.metric_current ??
                    input.metric_start ?? 0
            }).select("*").single();
            if(error) throw error;
            try {
                if(initialStages.length){
                    const created=await supabase.from("at_goal_stages").insert(initialStages.map((s,i)=>({
                        goal_id:goal.id,title:s.title,weight:s.weight ?? 1,completion_percent:s.completion_percent ?? null,position:i
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
            return res.status(201).json({success:true,goal:await detail(supabase,goal,req.query?.timezone)});
        }catch(error){return fail(res,error);}
    });

    app.get("/goal-workspace/:id",auth,async(req,res)=>{
        if(!req.user?.id) return unauthorized(res);
        try{
            const goal=await owned(supabase,req.params.id,req.user.id);
            if(!goal) return missing(res);
            return res.json({success:true,goal:await detail(supabase,goal,req.query?.timezone)});
        }catch(error){return fail(res,error);}
    });

    app.get("/goal-workspace/:id/periods",auth,async(req,res)=>{
        if(!req.user?.id) return unauthorized(res);
        try{
            const goal=await owned(supabase,req.params.id,req.user.id);
            if(!goal)return missing(res);
            let query=supabase.from("at_goal_periods").select("id,frequency,period_start,period_end,progress,completed,closed_at").eq("goal_id",goal.id).order("id",{ascending:false}).limit(50);
            if(req.query?.before!==undefined){if(!validId(req.query.before))return invalid(res);query=query.lt("id",req.query.before);}
            const {data,error}=await query;if(error)throw error;
            return res.json({success:true,periods:data || []});
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
            if(habit_ids!==undefined && !await validateLinks(supabase,req.user.id,"habit",habit_ids,old.id)) return missing(res);
            if(plan_ids!==undefined && !await validateLinks(supabase,req.user.id,"plan",plan_ids,old.id)) return missing(res);
            if(automaticMode(input.progress_mode ?? old.progress_mode)){
                let ids=habit_ids;
                if(ids===undefined){
                    const {data:links,error}=await supabase.from("at_goal_habit_links").select("habit_id").eq("goal_id",old.id);
                    if(error) throw error;
                    ids=(links || []).map(l=>l.habit_id);
                }
                if(!ids.length) return invalid(res);
                if((habit_ids!==undefined || input.progress_mode!==undefined) && !await validateHabitMetric(supabase,input.progress_mode ?? old.progress_mode,ids)) return invalid(res);
            }
            const {data:updatedGoal,error}=await supabase.rpc("at_update_goal_and_links",{
                p_goal_id:old.id,p_owner:req.user.id,p_fields:input,
                p_habit_ids:habit_ids===undefined?null:[...new Set(habit_ids.map(Number))],
                p_plan_ids:plan_ids===undefined?null:[...new Set(plan_ids.map(Number))]
            });
            if(error) throw error;
            const goal=Array.isArray(updatedGoal)?updatedGoal[0]:updatedGoal;
            if(!goal?.id) throw new Error("Goal update returned no row");
            await event(supabase,goal.id,req.user.id,"updated",{
                status:goal.status,progress_mode:goal.progress_mode
            });
            return res.json({success:true,goal:await detail(supabase,goal,req.query?.timezone)});
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
                goal_id:goal.id,title:input.title,weight:input.weight ?? 1,completion_percent:input.completion_percent ?? null,
                position:existing?.length ? Number(existing[0].position)+1 : 0
            });
            if(error) throw error;
            await event(supabase,goal.id,req.user.id,"stage_added");
            return res.json({success:true,goal:await detail(supabase,goal,req.query?.timezone)});
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
            return res.json({success:true,goal:await detail(supabase,goal,req.query?.timezone)});
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
            return res.json({success:true,goal:await detail(supabase,goal,req.query?.timezone)});
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
            if(body.kind==="habit" && !await validateHabitMetric(supabase,goal.progress_mode,[target.id])) return invalid(res);
            const [,,table,idCol]=targets[body.kind];
            const {error}=await supabase.from(table).upsert({
                goal_id:goal.id,[idCol]:target.id
            },{onConflict:"goal_id,"+idCol});
            if(error) throw error;
            await event(supabase,goal.id,req.user.id,"link_added",{kind:body.kind,id:target.id});
            return res.json({success:true,goal:await detail(supabase,goal,req.query?.timezone)});
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
            return res.json({success:true,goal:await detail(supabase,goal,req.query?.timezone)});
        }catch(error){return fail(res,error);}
    });
}
