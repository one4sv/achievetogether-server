import { isEvenScheduleWeek } from "./scheduleWeek.js";

export const isAutomaticMode = mode => ["days","streak","daily_timer"].includes(mode);
export const validTrackingZone = zone => {
    if(typeof zone !== "string" || !zone || zone.length > 64) return false;
    try { new Intl.DateTimeFormat("en-CA",{timeZone:zone}); return true; } catch { return false; }
};
const MS=86400000;
const dayNumber=day=>Date.parse(day+"T00:00:00Z")/MS;
const dateString=n=>new Date(n*MS).toISOString().slice(0,10);
const dayKey=(value,zone)=>{
    const parts=new Intl.DateTimeFormat("en-CA",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(value));
    return ["year","month","day"].map(type=>parts.find(p=>p.type===type).value).join("-");
};
const clockKey=(value,zone)=>new Intl.DateTimeFormat("en-GB",{timeZone:zone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(value));

export function isTrackingDay(habit, day, planned, blocks=[], separated=false, weekStart, completed=false) {
    if(day < habit.start_date || (habit.end_date && day > habit.end_date)) return false;
    if(planned) return true;
    const weekday=new Date(day+"T00:00:00Z").getUTCDay();
    const elapsed=dayNumber(day)-dayNumber(habit.start_date);
    const active=Number(habit.cycle_days_active || 0), rest=Number(habit.cycle_days_rest || 0);
    const recurring=habit.periodicity==="everyday" ||
        habit.periodicity==="weekly" && (habit.chosen_days || []).map(Number).includes(weekday) ||
        habit.periodicity==="cycle" && active>0 && elapsed>=0 && elapsed%(active+rest)<active;
    const hasBlock=blocks.some(b=>Number(b.day_of_week)===weekday &&
        (!separated || Boolean(b.isSeparator)===isEvenScheduleWeek(weekStart,day)));
    if(habit.periodicity==="sometimes") return hasBlock || completed;
    return recurring && (!blocks.length || hasBlock);
}

function union(intervals) {
    const merged=[];
    for(const [start,end] of intervals.filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>a).sort((a,b)=>a[0]-b[0])){
        const last=merged.at(-1);
        if(last && start<=last[1]) last[1]=Math.max(last[1],end);
        else merged.push([start,end]);
    }
    return merged;
}
export function minutesByDay(timers, zone) {
    const intervals=[];
    for(const timer of timers){
        if(timer.status!=="ended") continue;
        const start=Date.parse(timer.started_at),end=Date.parse(timer.end_at);
        if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start) continue;
        let cursor=start;
        const pauses=union((timer.pauses || []).map(p=>[Math.max(start,Date.parse(p.start)),Math.min(end,p.end?Date.parse(p.end):end)]));
        for(const [a,b] of pauses){ if(a>cursor) intervals.push([cursor,a]);cursor=Math.max(cursor,b); }
        if(cursor<end) intervals.push([cursor,end]);
    }
    const result=new Map();
    for(const [start,end] of union(intervals)){
        let cursor=start;
        while(cursor<end){
            const day=dayKey(cursor,zone);
            let boundary=end;
            if(dayKey(end-1,zone)!==day){
                let lo=cursor,hi=Math.min(end,cursor+2*MS);
                while(hi-lo>1){const mid=Math.floor((lo+hi)/2);if(dayKey(mid,zone)===day)lo=mid;else hi=mid;}
                boundary=hi;
            }
            result.set(day,(result.get(day)||0)+(boundary-cursor)/60000);
            cursor=boundary;
        }
    }
    return result;
}

export function trackedDayCount(goal, habit, {completions=[], planned=[], timers=[], blocks=[], separated=false, weekStart, now=new Date()}={}) {
    if(!habit || !goal.tracking_start || !validTrackingZone(goal.tracking_timezone)) return 0;
    const zone=goal.tracking_timezone;
    const today=dayKey(now,zone), end=goal.due_date && goal.due_date<today ? goal.due_date : today;
    const done=new Set(completions.map(x=>x.completed_at));
    const plans=new Set(planned.map(x=>x.planned_at));
    const minutes=goal.progress_mode==="daily_timer"?minutesByDay(timers,zone):new Map();
    const target=Number(goal.tracking_days), threshold=Number(goal.tracking_minutes);
    let total=0, streak=0, best=0;
    const start=Math.max(dayNumber(goal.tracking_start),dayNumber(habit.start_date));
    for(let n=start;n<=dayNumber(end);n++){
        const day=dateString(n);
        const success=goal.progress_mode==="daily_timer" ? (minutes.get(day)||0)>=threshold : done.has(day);
        if(!isTrackingDay(habit,day,plans.has(day),blocks,separated,weekStart,success)) continue;
        if(success){total++;streak++;best=Math.max(best,streak);}
        else if(day<today || (habit.end_time && clockKey(now,zone)>=habit.end_time.slice(0,5))) streak=0;
        if(goal.progress_mode==="days" && total>=target || goal.progress_mode!=="days" && best>=target) return target;
    }
    return goal.progress_mode==="days"?total:streak;
}

async function rows(build) {
    const result=[];
    for(let offset=0;;offset+=500){
        const {data,error}=await build().order("id",{ascending:true}).range(offset,offset+499);
        if(error) throw error;
        result.push(...(data || []));
        if(!data || data.length<500) return result;
    }
}
export async function loadTrackedDays(supabase, goal) {
    if(!isAutomaticMode(goal.progress_mode)||!goal.tracking_habit_id||!goal.tracking_start) return 0;
    const {data:habit,error}=await supabase.from("habits").select("id,user_id,start_date,end_date,periodicity,chosen_days,cycle_days_active,cycle_days_rest,end_time")
        .eq("id",goal.tracking_habit_id).eq("user_id",goal.owner_id).maybeSingle();
    if(error) throw error;
    if(!habit) return 0;
    const id=habit.id,owner=goal.owner_id;
    const [config,week,scheduleConfig]=await Promise.all([
        supabase.from("habits_settings").select("schedule,metric_type").eq("habit_id",id).maybeSingle(),
        supabase.from("settings").select("week_start").eq("user_id",owner).maybeSingle(),
        supabase.from("schedule_settings").select("isSeparated").eq("habit_id",id).maybeSingle()
    ]);
    for(const r of [config,week,scheduleConfig]) if(r.error) throw r.error;
    const [completions,planned,blocks,timers]=await Promise.all([
        rows(()=>supabase.from("habit_completions").select("id,completed_at").eq("habit_id",id).eq("user_id",owner).gte("completed_at",goal.tracking_start)),
        rows(()=>supabase.from("habit_planned").select("id,planned_at").eq("habit_id",id).gte("planned_at",goal.tracking_start)),
        config.data?.schedule ? rows(()=>supabase.from("schedule").select("id,day_of_week,isSeparator").eq("habit_id",id).eq("user_id",owner)):[],
        goal.progress_mode==="daily_timer"?rows(()=>supabase.from("habit_timers").select("id,started_at,end_at,status,pauses").eq("habit_id",id).eq("user_id",owner)
            .eq("status","ended").gte("end_at",new Date(Date.parse(goal.tracking_start+"T00:00:00Z")-MS).toISOString())):[]
    ]);
    return trackedDayCount(goal,habit,{completions,planned,blocks,timers,separated:!!scheduleConfig.data?.isSeparated,weekStart:week.data?.week_start});
}
