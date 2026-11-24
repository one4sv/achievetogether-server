import { automaticMode, readActivityProgress, goalDay, dayStart, ownerGoalZone } from "./activityGoalProgress.js";
import { goalProgress } from "./goalWorkspace.js";

export const repeating = goal => ["daily","weekly","monthly"].includes(goal.repeat_frequency);
export function nextPeriod(start,frequency) {
    const date=new Date(start+"T00:00:00Z");
    if(frequency==="daily") date.setUTCDate(date.getUTCDate()+1);
    else if(frequency==="weekly") date.setUTCDate(date.getUTCDate()+7-((date.getUTCDay()+6)%7));
    else if(frequency==="monthly") {date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+1);}
    else return null;
    return date.toISOString().slice(0,10);
}
const rows=async query=>{const {data,error}=await query;if(error)throw error;return data || [];};
export async function advanceGoalPeriod(supabase,goal,habitIds,stages,zone,now=new Date()) {
    if(!repeating(goal) || !goal.repeat_period_start || ["archived","canceled"].includes(goal.status))return {goal,stages};
    const today=goalDay(now,zone);
    let next=nextPeriod(goal.repeat_period_start,goal.repeat_frequency);
    if(next>today || (goal.due_date && next>goal.due_date))return {goal,stages};
    if(!habitIds)habitIds=(await rows(supabase.from("at_goal_habit_links").select("habit_id").eq("goal_id",goal.id))).map(l=>l.habit_id);
    if(!stages)stages=await rows(supabase.from("at_goal_stages").select("*").eq("goal_id",goal.id));
    // Catch up closed periods independently, including periods missed while the app was closed.
    for(let i=0;i<366 && next<=today && (!goal.due_date || next<=goal.due_date);i++){
        const end=new Date(dayStart(next,zone)-1);
        const progress=automaticMode(goal.progress_mode)?(await readActivityProgress(supabase,goal,habitIds,zone,end)).progress:goalProgress(goal,stages);
        const following=nextPeriod(next,goal.repeat_frequency);
        const {data,error}=await supabase.rpc("at_roll_goal_period",{
            p_goal_id:goal.id,p_owner:goal.owner_id,p_expected_start:goal.repeat_period_start,p_expected_frequency:goal.repeat_frequency,
            p_next_start:next,p_next_at:new Date(dayStart(following,zone)).toISOString(),p_progress:progress
        });
        if(error)throw error;
        const updated=Array.isArray(data)?data[0]:data;
        if(!updated?.id){
            const result=await supabase.from("at_goals").select("*").eq("id",goal.id).eq("owner_id",goal.owner_id).maybeSingle();
            if(result.error)throw result.error;
            goal=result.data || goal;
            stages=await rows(supabase.from("at_goal_stages").select("*").eq("goal_id",goal.id));
            break;
        }
        goal=updated;
        stages=stages.map(s=>({...s,completed_at:null}));
        next=following;
    }
    return {goal,stages};
}

export async function prepareOwnedGoal(supabase,goal,requestedZone) {
    if(!goal || !repeating(goal))return goal;
    // Recurrence follows the synchronized account timezone, not conflicting device requests.
    const zone=await ownerGoalZone(supabase,goal.owner_id);
    return (await advanceGoalPeriod(supabase,goal,undefined,undefined,zone)).goal;
}
