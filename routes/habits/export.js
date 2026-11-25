import { authenticateUser } from "../../middleware/token.js";
import { requireHabitPermission,getHabitAccess } from "../../utils/habitAccess.js";

// Use explicit field lists and actor filters. The owner of shared storage is
// not necessarily the actor; never export unattributed shared metric rows.
export async function exportRows(query,order="id"){
    const rows=[];
    for(let offset=0;;offset+=500){
        const {data,error}=await query().order(order).range(offset,offset+499);
        if(error)throw error;
        rows.push(...(data || []));
        if(!data || data.length<500)return rows;
    }
}
export const actorFilter=(userId,shared)=>shared
    ? "actor_user_id.eq."+userId
    : "actor_user_id.eq."+userId+",and(actor_user_id.is.null,user_id.eq."+userId+")";

export default function habitExport(app,db){
    app.get("/habits/:id/export",authenticateUser(db),requireHabitPermission(db,"view"),async(req,res)=>{
        const {habit,is_owner,is_member}=req.habitAccess;
        const actor=req.user.id;
        if(!is_owner && !is_member)return res.sendStatus(403);
        try{
            const id=habit.id;
            const rows=(table,fields,filter=q=>q)=>exportRows(()=>filter(db.from(table).select(fields).eq("habit_id",id)));
            const personal=habit.metric_progress_mode!=="shared";
            const privateHabit=!habit.chat_id;
            const [settings,counterSettings,scheduleSettings,completions,comments,timers,counters,schedule,scheduleCompletions,patterns,planned,events,links]=await Promise.all([
                rows("habits_settings","metric_type,schedule,auto_schedule_completion"),
                rows("counter_settings","min_counter,red_counter_right,red_counter_left"),
                rows("schedule_settings","color,isSeparated"),
                rows("habit_completions","id,completed_at,created_at,is_user_marked",q=>q.or(actorFilter(actor,habit.completion_mode==="shared"))),
                rows("completions_comments","id,date,created_at,comment,photo_ids",q=>q.eq("user_id",actor)),
                personal?rows("habit_timers","id,started_at,end_at,status,circles,pauses,done_id",q=>q.eq("user_id",actor)):[],
                personal?rows("habit_counters","id,created_at,count,min_count,progression,done_id",q=>q.eq("user_id",actor)):[],
                rows("schedule","id,day_of_week,isSeparator,name,start_time,end_time,created_at",q=>q.eq("created_by",actor)),
                rows("schedule_completions","id,schedule_id,date,created_at",q=>q.or(actorFilter(actor,habit.completion_mode==="shared"))),
                habit.schedule_blocks_mode!=="shared"?rows("checklist_pattern","id,name,start_time,end_time,created_at",q=>q.eq("user_id",actor)):[],
                privateHabit && is_owner?rows("habit_planned","id,planned_at,created_at"):[],
                rows("habit_activity_events","id,type,created_at,details",q=>q.eq("user_id",actor)),
                exportRows(()=>db.from("at_goal_habit_links").select("goal_id").eq("habit_id",id),"goal_id")
            ]);
            // Checklist rows may contain another person's completion. Split
            // creation and completion records so only the actor's marks survive.
            const ownChecklist=await rows("checklist_completions","id,name,date,start_time,end_time,created_at",q=>q.eq("created_by",actor));
            const ownChecklistCompletions=await rows("checklist_completions","id,date,completed_at",q=>q.eq("completed_by",actor));
            const goals=[];
            for(const link of links){
                const {data:g,error}=await db.from("at_goals").select("id,name,description,progress_mode,due_date,status,manual_progress,metric_start,metric_target,metric_current,metric_unit,metric_share,target_days,daily_minutes,repeat_frequency,auto_complete,created_at,updated_at,shared_habit_id,template_goal_id").eq("id",link.goal_id).eq("owner_id",actor).maybeSingle();
                if(error)throw error;
                if(!g || (g.shared_habit_id && (!g.template_goal_id || habit.goal_completion_mode!=="personal" || habit.goal_scope!=="shared")))continue;
                const stages=await exportRows(()=>db.from("at_goal_stages").select("id,title,position,completion_percent,completed_at").eq("goal_id",g.id));
                const actions=await exportRows(()=>db.from("at_goal_events").select("id,action,created_at").eq("goal_id",g.id).eq("actor_id",actor));
                const {shared_habit_id,template_goal_id,...definition}=g;
                // Do not include derived aggregate progress/periods for a shared
                // activity or a goal linked to other activities.
                const goalLinks=await exportRows(()=>db.from("at_goal_habit_links").select("habit_id").eq("goal_id",g.id),"habit_id");
                const planLinks=await exportRows(()=>db.from("at_goal_plan_links").select("plan_id").eq("goal_id",g.id),"plan_id");
                const periods=privateHabit && goalLinks.length===1 && !planLinks.length
                    ?await exportRows(()=>db.from("at_goal_periods").select("frequency,period_start,period_end,progress,completed,closed_at").eq("goal_id",g.id)): undefined;
                goals.push({...definition,stages,actions,periods});
            }
            const access=await getHabitAccess(db,id,actor);
            if(!access?.is_owner && !access?.is_member)return res.sendStatus(403);
            res.set("Cache-Control","private, no-store").json({success:true,export:{
                schema_version:1,exported_at:new Date().toISOString(),
                scope:"requesting_user_only",
                activity:{id,name:habit.name,description:habit.desc,tag:habit.tag,start_date:habit.start_date,end_date:habit.end_date,start_time:habit.start_time,end_time:habit.end_time,ongoing:habit.ongoing,periodicity:habit.periodicity,chosen_days:habit.chosen_days,cycle_days_active:habit.cycle_days_active,cycle_days_rest:habit.cycle_days_rest,completion_mode:habit.completion_mode,metric_progress_mode:habit.metric_progress_mode,settings:settings[0] || null,counter_settings:counterSettings[0] || null,schedule_settings:scheduleSettings[0] || null},
                completions,comments:comments.map(({photo_ids,...c})=>({...c,photo_count:photo_ids?.length || 0})),timers,counters,schedule,schedule_completions:scheduleCompletions,checklist:ownChecklist,checklist_completions:ownChecklistCompletions,checklist_patterns:patterns,planned_days:planned,
                journal:events.map(({details,...e})=>({...e,date:typeof details?.date==="string"?details.date:null})),goals,
                exclusions:["Other participants' records and identities","Shared timer/counter records without individual attribution","Unattributed shared planning/checklist templates","Shared goal aggregate progress and periods not attributable to one activity","Photo binaries (only counts are included)"]
            }});
        }catch(error){console.error("Habit export",error);res.status(500).json({success:false});}
    });
}
