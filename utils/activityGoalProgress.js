// Civil completion dates are preserved; absolute timestamps use the goal owner timezone.
export const automaticMode = mode => ["days","streak","daily_timer","daily_counter","total_timer"].includes(mode);
export const requiredHabitMetric = mode => mode==="daily_timer" || mode==="total_timer" ? "timer" : mode==="daily_counter" ? "counter" : null;
export function validZone(value){
    if(typeof value!=="string" || value.length>100) return false;
    try{new Intl.DateTimeFormat("en-US",{timeZone:value});return true;}catch{return false;}
}
const zoneFormatters=new Map();
export function goalDay(value,zone="Europe/Moscow"){
    if(!zoneFormatters.has(zone)){
        if(zoneFormatters.size>=64)zoneFormatters.clear();
        zoneFormatters.set(zone,new Intl.DateTimeFormat("en-US",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit"}));
    }
    const parts=zoneFormatters.get(zone).formatToParts(new Date(value));
    const get=type=>parts.find(p=>p.type===type).value;
    return get("year")+"-"+get("month")+"-"+get("day");
}
// Binary-search the first instant of the civil day (including 23/25-hour DST days).
const dayStarts=new Map();
export function dayStart(date,zone){
    const key=zone+"|"+date;
    if(dayStarts.has(key))return dayStarts.get(key);
    const utc=Date.parse(date+"T00:00:00Z");
    let left=utc-36*3600000,right=utc+36*3600000;
    while(right-left>1){
        const mid=Math.floor((left+right)/2);
        if(goalDay(mid,zone)<date) left=mid;else right=mid;
    }
    if(dayStarts.size>=4096)dayStarts.clear();
    dayStarts.set(key,right);
    return right;
}
export async function ownerGoalZone(supabase,owner,requested){
    if(validZone(requested)) return requested;
    const {data,error}=await supabase.from("at_habit_reminder_preferences").select("timezone").eq("user_id",owner).maybeSingle();
    if(error) throw error;
    return validZone(data?.timezone)?data.timezone:"UTC";
}
const dayMs = 86400000;
const dayNumber = date => Date.parse(date+"T00:00:00Z")/dayMs;
const nextDay = date => new Date((dayNumber(date)+1)*dayMs).toISOString().slice(0,10);
const key = (id,date) => String(id)+":"+date;

export function scheduled(habit,date,planned,done) {
    if(date<habit.start_date || (habit.end_date && date>habit.end_date)) return false;
    if(habit.periodicity==="everyday") return true;
    if(habit.periodicity==="weekly") return (habit.chosen_days || []).map(Number).includes(new Date(date+"T00:00:00Z").getUTCDay());
    if(habit.periodicity==="cycle"){
        const active=Number(habit.cycle_days_active || 0), rest=Number(habit.cycle_days_rest || 0);
        const offset=dayNumber(date)-dayNumber(habit.start_date);
        return active>0 && offset>=0 && offset%(active+rest)<active;
    }
    return habit.periodicity==="sometimes" && (planned.has(key(habit.id,date)) || done.has(key(habit.id,date)));
}

function timerSecondsInRange(timer,begin,end,now=Date.now(),includeRunning=false) {
    if(timer.status!=="ended" && !includeRunning) return 0;
    const stop=timer.status==="ended"?Date.parse(timer.end_at):now;
    const left=Math.max(begin,Date.parse(timer.started_at)), right=Math.min(end,stop);
    if(!Number.isFinite(left) || !Number.isFinite(right) || right<=left) return 0;
    const intervals=(Array.isArray(timer.pauses)?timer.pauses:[]).map(p=>[
        Math.max(left,Date.parse(p.start)),Math.min(right,(p.end?Date.parse(p.end):stop))
    ]).filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>a).sort((a,b)=>a[0]-b[0]);
    let lost=0, cursor=left;
    for(const [a,b] of intervals){lost+=Math.max(0,b-Math.max(a,cursor));cursor=Math.max(cursor,b);}
    return Math.max(0,right-left-lost)/1000;
}

export function timerSeconds(timer,date,zone="Europe/Moscow",now=Date.now(),includeRunning=false) {
    return timerSecondsInRange(timer,dayStart(date,zone),dayStart(nextDay(date),zone),now,includeRunning);
}

export function activityGoalProgress(goal,habits,completions,plans,timers,today=goalDay(new Date()),counters=[],zone="Europe/Moscow",now=Date.now()) {
    const target=Number(goal.target_days || 1);
    const start=goal.repeat_period_start || goalDay(goal.created_at,zone);
    const end=goal.due_date && goal.due_date<today ? goal.due_date : today;
    if(goal.progress_mode==="total_timer") {
        const targetSeconds=Number(goal.metric_target)*60;
        if(!habits.length || start>end || !(targetSeconds>0)) return {progress:0,achieved_minutes:0};
        const ids=new Set(habits.map(h=>String(h.id)));
        const begin=dayStart(start,zone), finish=Math.min(now,dayStart(nextDay(end),zone));
        const seconds=timers.filter(timer=>ids.has(String(timer.habit_id))).reduce((sum,timer)=>sum+timerSecondsInRange(timer,begin,finish,now),0);
        return {progress:Math.min(100,Math.round(seconds/targetSeconds*10000)/100),achieved_minutes:Math.round(seconds/60*100)/100};
    }
    const done=new Set(completions.map(row=>key(row.habit_id,row.completed_at)));
    const planned=new Set(plans.map(row=>key(row.habit_id,row.planned_at)));
    const byHabit=new Map();
    for(const timer of timers){const id=String(timer.habit_id);if(!byHabit.has(id))byHabit.set(id,[]);byHabit.get(id).push(timer);}
    const counterByDay=new Map();
    for(const row of counters){const k=key(row.habit_id,goalDay(row.created_at,zone));counterByDay.set(k,Math.max(counterByDay.get(k) || 0,Number(row.count) || 0));}
    let count=0,streak=0,best=0;
    let today_progress=null,today_current=null,today_target=null;
    if(!habits.length || start>end) return {progress:0,achieved_days:0};
    for(let date=start;date<=end;date=nextDay(date)){
        const due=habits.filter(h=>scheduled(h,date,planned,done));
        if(!due.length) continue;
        const fulfilled=due.every(h=>goal.progress_mode==="daily_timer" ?
            (byHabit.get(String(h.id)) || []).reduce((sum,t)=>sum+timerSeconds(t,date,zone),0)>=Number(goal.daily_minutes || 60)*60 :
            goal.progress_mode==="daily_counter" ? (counterByDay.get(key(h.id,date)) || 0)>=Number(goal.metric_target) : done.has(key(h.id,date)));
        if(date===today){
            const threshold=goal.progress_mode==="daily_timer"?Number(goal.daily_minutes || 60)*60:goal.progress_mode==="daily_counter"?Number(goal.metric_target):1;
            const values=due.map(h=>goal.progress_mode==="daily_timer"?
                (byHabit.get(String(h.id)) || []).reduce((sum,t)=>sum+timerSeconds(t,date,zone,now,true),0):
                goal.progress_mode==="daily_counter"?(counterByDay.get(key(h.id,date)) || 0):Number(done.has(key(h.id,date))));
            // For multiple scheduled activities every one must meet the threshold.
            today_current=Math.min(...values);
            today_target=threshold;
            today_progress=Math.min(100,Math.round(today_current/threshold*10000)/100);
        }
        if(fulfilled){count++;streak++;best=Math.max(best,streak);}
        else if(date<today) streak=0;
    }
    // A goal to achieve a streak stays achieved once the required streak occurred.
    const achieved=goal.progress_mode==="streak"?best:count;
    return {progress:Math.min(100,Math.round(achieved/target*10000)/100),achieved_days:achieved,today_progress,today_current,today_target};
}

async function allRows(makeQuery) {
    const rows=[];
    for(let offset=0;;offset+=500){
        const {data,error}=await makeQuery().order("id",{ascending:true}).range(offset,offset+499);
        if(error) throw error;
        rows.push(...(data || []));
        if(!data || data.length<500) return rows;
    }
}

export async function readActivityProgress(supabase,goal,habitIds,zone="Europe/Moscow",asOf=new Date()) {
    if(!habitIds.length) return {progress:0,achieved_days:0};
    const {data:habits,error}=await supabase.from("habits")
        .select("id,start_date,end_date,periodicity,chosen_days,cycle_days_active,cycle_days_rest,habits_settings(metric_type)")
        .eq("user_id",goal.owner_id).in("id",habitIds);
    if(error) throw error;
    const required=requiredHabitMetric(goal.progress_mode);
    if(required && (habits || []).some(h=>{
        const settings=Array.isArray(h.habits_settings)?h.habits_settings[0]:h.habits_settings;
        return settings?.metric_type!==required;
    })) return {progress:0,achieved_days:0,achieved_minutes:0};
    const ids=(habits || []).map(h=>h.id);
    if(!ids.length) return {progress:0,achieved_days:0};
    const start=goal.repeat_period_start || goalDay(goal.created_at,zone),today=goalDay(asOf,zone);
    const from=new Date(dayStart(start,zone)).toISOString();
    const [completed,planned,timers,counters]=await Promise.all([
        allRows(()=>supabase.from("habit_completions").select("id,habit_id,completed_at").eq("user_id",goal.owner_id).in("habit_id",ids).gte("completed_at",start).lte("completed_at",today)),
        allRows(()=>supabase.from("habit_planned").select("id,habit_id,planned_at").in("habit_id",ids).gte("planned_at",start).lte("planned_at",today)),
        required==="timer"?allRows(()=>supabase.from("habit_timers").select("id,habit_id,started_at,end_at,status,pauses").eq("user_id",goal.owner_id).in("habit_id",ids).or("end_at.gte."+from+",status.in.(running,paused)")):Promise.resolve([]),
        goal.progress_mode==="daily_counter"?allRows(()=>supabase.from("habit_counters").select("id,habit_id,created_at,count").eq("user_id",goal.owner_id).in("habit_id",ids).gte("created_at",from)):Promise.resolve([])
    ]);
    return activityGoalProgress(goal,habits || [],completed,planned,timers,today,counters,zone,asOf.getTime());
}
