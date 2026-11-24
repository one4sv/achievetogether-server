import { calculateGoalProgress } from "../routes/goals/workspace.js";
import { advanceGoalPeriod } from "../utils/goalPeriods.js";
import { goalDay, ownerGoalZone } from "../utils/activityGoalProgress.js";
import { sendWebPush, validPushEndpoint, publicVapidKey } from "../utils/webPush.js";

let running=false;
const dayMs=86400000;
const shift=(date,days)=>new Date(Date.parse(date+"T00:00:00Z")+days*dayMs).toISOString().slice(0,10);
const rows=async query=>{const {data,error}=await query;if(error)throw error;return data || [];};

async function refreshDirty(supabase){
    const pending=await rows(supabase.from("at_goal_dirty").select("goal_id,queued_at").order("queued_at",{ascending:true}).limit(40));
    for(const job of pending){
        try{
            const {data:goal,error}=await supabase.from("at_goals").select("*").eq("id",job.goal_id).maybeSingle();
            if(error)throw error;
            if(goal){
                const [links,stages,zone]=await Promise.all([
                    rows(supabase.from("at_goal_habit_links").select("habit_id").eq("goal_id",goal.id)),
                    rows(supabase.from("at_goal_stages").select("id,position,weight,completion_percent,completed_at").eq("goal_id",goal.id)),
                    ownerGoalZone(supabase,goal.owner_id)
                ]);
                await calculateGoalProgress(supabase,goal,links.map(l=>l.habit_id),stages,zone);
            }
            await rows(supabase.from("at_goal_dirty").delete().eq("goal_id",job.goal_id).eq("queued_at",job.queued_at));
        }catch(error){console.error("[goals] recalculation:",error.message);}
    }
}

async function rollDuePeriods(supabase){
    const goals=await rows(supabase.from("at_goals").select("*").lte("repeat_next_at",new Date().toISOString()).in("status",["active","paused","completed"]).order("repeat_next_at").limit(100));
    for(const goal of goals){
        try{
            const zone=await ownerGoalZone(supabase,goal.owner_id);
            await advanceGoalPeriod(supabase,goal,undefined,undefined,zone);
        }catch(error){console.error("[goals] period rollover:",error.message);}
    }
}

export function reminderIsDue(goal,today){
    return goal.status==="active" && goal.due_date && Number.isInteger(goal.reminder_days) &&
        today===shift(goal.due_date,-goal.reminder_days);
}
async function deliver(supabase,goal,now){
    const [zone,settings,user]=await Promise.all([
        ownerGoalZone(supabase,goal.owner_id),
        supabase.from("settings").select("all_note").eq("user_id",goal.owner_id).maybeSingle(),
        supabase.from("users").select("deletion_requested_at").eq("id",goal.owner_id).maybeSingle()
    ]);
    if(settings.error || user.error)throw settings.error || user.error;
    if(!user.data || user.data.deletion_requested_at || settings.data?.all_note===false || !reminderIsDue(goal,goalDay(now,zone)))return;
    // One reminder on the selected civil date, from 09:00 local time.
    if(Number(new Intl.DateTimeFormat("en-GB",{timeZone:zone,hour:"2-digit",hourCycle:"h23"}).format(now))<9)return;
    const subscriptions=await rows(supabase.from("at_push_subscriptions").select("endpoint,endpoint_hash,p256dh,auth,expiration_time,session_id,language").eq("user_id",goal.owner_id).limit(10));
    const sessionIds=subscriptions.map(s=>s.session_id).filter(Boolean);
    if(!sessionIds.length)return;
    const active=new Set((await rows(supabase.from("at_user_sessions").select("id").in("id",sessionIds).is("revoked_at",null).gt("expires_at",now.toISOString()))).map(s=>s.id));
    const targets=subscriptions.filter(s=>active.has(s.session_id)&&validPushEndpoint(s.endpoint));
    if(!targets.length)return;
    const claim={goal_id:goal.id,due_date:goal.due_date,reminder_days:goal.reminder_days};
    const {data:claimed,error}=await supabase.from("at_goal_reminder_deliveries").upsert(claim,{onConflict:"goal_id,due_date,reminder_days",ignoreDuplicates:true}).select("goal_id");
    if(error)throw error;
    if(!claimed?.length)return;
    const sent=await Promise.allSettled(targets.map(async s=>{
        const result=await sendWebPush({endpoint:s.endpoint,expirationTime:s.expiration_time,keys:{p256dh:s.p256dh,auth:s.auth}},{
            title:"AchieveTogether",body:(s.language==="en"?"Goal deadline: ":"Срок цели: ")+String(goal.name).slice(0,90),
            url:"/habit",tag:"at-goal-deadline-"+goal.id+"-"+goal.due_date
        });
        if(result.status===404 || result.status===410)await supabase.from("at_push_subscriptions").delete().eq("user_id",goal.owner_id).eq("endpoint_hash",s.endpoint_hash);
        return result.delivered;
    }));
    if(!sent.some(r=>r.status==="fulfilled" && r.value)){
        await rows(supabase.from("at_goal_reminder_deliveries").delete().eq("goal_id",goal.id).eq("due_date",goal.due_date).eq("reminder_days",goal.reminder_days));
    }
}
async function reminders(supabase){
    if(!publicVapidKey())return;
    const now=new Date(),utc=now.toISOString().slice(0,10);
    for(let offset=0;;offset+=100){
        const goals=await rows(supabase.from("at_goals").select("id,owner_id,name,due_date,reminder_days,status")
            .eq("status","active").not("reminder_days","is",null).gte("due_date",shift(utc,-1)).lte("due_date",shift(utc,31)).order("id").range(offset,offset+99));
        for(let i=0;i<goals.length;i+=8)await Promise.allSettled(goals.slice(i,i+8).map(g=>deliver(supabase,g,now)));
        if(goals.length<100)break;
    }
}
export function startGoalWorker(supabase){
    const run=async()=>{
        if(running)return;
        running=true;
        try{await rollDuePeriods(supabase);await refreshDirty(supabase);await reminders(supabase);}
        catch(error){console.error("[goals] worker:",error.message);}
        finally{running=false;}
    };
    setTimeout(()=>void run(),6000).unref?.();
    setInterval(()=>void run(),60000).unref?.();
}
