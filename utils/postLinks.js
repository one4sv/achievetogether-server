import { getHabitAccess } from "./habitAccess.js";
import { sharedGoalAccess } from "./sharedGoalAccess.js";
import { access as planAccess, publicPlanAccess } from "../routes/plans/plans.js";
import { ownerGoalZone, goalDay } from "./activityGoalProgress.js";
const row=async query=>{const {data,error}=await query;if(error)throw error;return data;};
const same=(a,b)=>String(a)===String(b);
export const validPostLink=id=>id===null || (/^\d+$/.test(String(id)) && Number.isSafeInteger(Number(id)) && Number(id)>0);
export const currentGoal=g=>g.status==="active" || g.status==="paused" || (g.status==="completed" && Boolean(g.repeat_next_at));
export const compatiblePostLinks=(habit,plan,goal,habitIds,planIds)=>
    (!habit || !plan || !!goal) &&
    (!goal || ((!habit || habitIds.some(id=>same(id,habit))) && (!plan || planIds.some(id=>same(id,plan)))));
export async function validatePostLinks(db,user,{habit_id,goal_id,plan_id},zone){
    if(![habit_id,goal_id,plan_id].every(validPostLink))return false;
    if(habit_id){
        const h=await getHabitAccess(db,habit_id,user);
        if(!h?.is_member || !h.habit.ongoing)return false;
    }
    if(plan_id){
        const p=await planAccess(db,plan_id,user);
        if(p?.status!=="accepted" || p.plan.status==="canceled")return false;
        const tz=await ownerGoalZone(db,user,zone);
        const now=new Date(),today=goalDay(now,tz);
        const clock=new Intl.DateTimeFormat("en-GB",{timeZone:tz,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(now);
        const end=(p.plan.end_time || p.plan.start_time || "").slice(0,5);
        if(p.plan.plan_date<today || (p.plan.plan_date===today && end && end<=clock))return false;
    }
    let hIds=[],pIds=[];
    if(goal_id){
        const g=await row(db.from("at_goals").select("*").eq("id",goal_id).maybeSingle());
        const a=await sharedGoalAccess(db,g,user);
        if(!a || !currentGoal(a.goal))return false;
        hIds=(await row(db.from("at_goal_habit_links").select("habit_id").eq("goal_id",a.goal.id)) || []).map(x=>x.habit_id);
        pIds=(await row(db.from("at_goal_plan_links").select("plan_id").eq("goal_id",a.goal.id)) || []).map(x=>x.plan_id);
    }
    return compatiblePostLinks(habit_id,plan_id,goal_id,hIds,pIds);
}
export async function visiblePostExtraLinks(db,post,viewer,share){
    let goal=null,plan=null;
    if(post.goal_id && viewer){
        const g=await row(db.from("at_goals").select("*").eq("id",post.goal_id).maybeSingle());
        const a=await sharedGoalAccess(db,g,viewer);
        if(a)goal={id:a.goal.id,name:a.goal.name};
    }
    if(post.plan_id){
        const p=await row(db.from("one_off_plans").select("*").eq("id",post.plan_id).maybeSingle());
        if(p){
            const a=viewer?await planAccess(db,p.id,viewer):null;
            if(a?.status==="accepted" || (!a && await publicPlanAccess(db,p,viewer,share))){
                const {id,name,tag,avatar_key}=p;
                plan={id,name,tag,avatar_key};
            }
        }
    }
    return {goal,plan};
}
