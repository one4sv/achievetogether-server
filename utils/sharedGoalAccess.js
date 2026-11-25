import { linkedGroupPermission } from "./hasPermission.js";
import { getHabitAccess } from "./habitAccess.js";

const row=async query=>{const {data,error}=await query;if(error)throw error;return data;};
const one=data=>Array.isArray(data)?data[0]:data;
export async function sharedGoalAccess(supabase,goal,userId){
    if(!goal)return null;
    if(!goal.shared_habit_id)return goal.owner_id===userId?{goal,canEdit:true,canProgress:true}:null;
    const access=await getHabitAccess(supabase,goal.shared_habit_id,userId);
    if(!access?.is_member)return null;
    const owner=goal.owner_id===userId;
    const habit=access.habit;
    const canProgress=access.can_complete && await linkedGroupPermission(supabase, habit.chat_id, userId, "goal_progress");
    if(goal.template_goal_id){
        if(!owner || habit.goal_scope!=="shared" || habit.goal_completion_mode!=="personal")return null;
        const synced=one(await row(supabase.rpc("at_ensure_activity_goal_instance",{p_template:goal.template_goal_id,p_user:userId})));
        if(!synced?.id)return null;
        return {goal:synced,canEdit:false,canProgress,canManageDefinition:access.is_owner};
    }
    if(!owner && (habit.goal_scope!=="shared" || habit.goal_completion_mode!=="shared"))return null;
    return {goal,canEdit:owner && access.is_owner,canProgress:canProgress && habit.goal_scope==="shared" && habit.goal_completion_mode==="shared"};
}
export async function visibleActivityGoals(supabase,own,userId){
    const accepted=await row(supabase.from("habit_members").select("habit_id").eq("user_id",userId).eq("status","accepted")) || [];
    const result=own.filter(g=>!g.shared_habit_id);
    const ids=[...new Set(accepted.map(m=>m.habit_id))];
    const linked=ids.length?await row(supabase.from("at_goals").select("*").in("shared_habit_id",ids).is("template_goal_id",null)) || []:[];
    const definitions=[...new Map([...own.filter(g=>g.shared_habit_id && !g.template_goal_id),...linked].map(g=>[String(g.id),g])).values()];
    for(const template of definitions){
        const access=await getHabitAccess(supabase,template.shared_habit_id,userId);
        if(!access?.is_member || access.habit.goal_scope!=="shared")continue;
        if(["archived","canceled"].includes(template.status)){
            if(access.is_owner)result.push(template);
            continue;
        }
        if(access.habit.goal_completion_mode==="shared")result.push(template);
        else {
            const instance=one(await row(supabase.rpc("at_ensure_activity_goal_instance",{p_template:template.id,p_user:userId})));
            if(instance?.id)result.push(instance);
        }
    }
    return result;
}
export function publicGoalPermissions(goal,access){
    return {...goal,can_edit:access?.canEdit!==false,can_progress:access?.canProgress!==false,can_manage_definition:Boolean(access?.canManageDefinition)};
}
export function validSharedProgressPatch(input){
    return input && Object.keys(input).every(key=>["manual_progress","metric_current","status"].includes(key)) &&
        (!("status" in input) || ["active","completed"].includes(input.status));
}
