// Dates follow the existing habit calendar/timer contract (Europe/Moscow).
export const automaticMode = mode => ["days","streak","daily_timer","daily_counter"].includes(mode);
export const goalDay = value => new Date(value).toLocaleDateString("en-CA",{timeZone:"Europe/Moscow"});
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

export function timerSeconds(timer,date) {
    if(timer.status!=="ended") return 0;
    const begin=Date.parse(date+"T00:00:00+03:00"), end=begin+dayMs;
    const left=Math.max(begin,Date.parse(timer.started_at)), right=Math.min(end,Date.parse(timer.end_at));
    if(!Number.isFinite(left) || !Number.isFinite(right) || right<=left) return 0;
    const intervals=(Array.isArray(timer.pauses)?timer.pauses:[]).map(p=>[
        Math.max(left,Date.parse(p.start)),Math.min(right,Date.parse(p.end || timer.end_at))
    ]).filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>a).sort((a,b)=>a[0]-b[0]);
    let lost=0, cursor=left;
    for(const [a,b] of intervals){lost+=Math.max(0,b-Math.max(a,cursor));cursor=Math.max(cursor,b);}
    return Math.max(0,right-left-lost)/1000;
}

export function activityGoalProgress(goal,habits,completions,plans,timers,today=goalDay(new Date()),counters=[]) {
    const target=Number(goal.target_days || 1);
    const start=goalDay(goal.created_at);
    const end=goal.due_date && goal.due_date<today ? goal.due_date : today;
    const done=new Set(completions.map(row=>key(row.habit_id,row.completed_at)));
    const planned=new Set(plans.map(row=>key(row.habit_id,row.planned_at)));
    const byHabit=new Map();
    for(const timer of timers){const id=String(timer.habit_id);if(!byHabit.has(id))byHabit.set(id,[]);byHabit.get(id).push(timer);}
    const counterByDay=new Map();
    for(const row of counters){const k=key(row.habit_id,goalDay(row.created_at));counterByDay.set(k,Math.max(counterByDay.get(k) || 0,Number(row.count) || 0));}
    let count=0,streak=0,best=0;
    if(!habits.length || start>end) return {progress:0,achieved_days:0};
    for(let date=start;date<=end;date=nextDay(date)){
        const due=habits.filter(h=>scheduled(h,date,planned,done));
        if(!due.length) continue;
        const fulfilled=due.every(h=>goal.progress_mode==="daily_timer" ?
            (byHabit.get(String(h.id)) || []).reduce((sum,t)=>sum+timerSeconds(t,date),0)>=Number(goal.daily_minutes || 60)*60 :
            goal.progress_mode==="daily_counter" ? (counterByDay.get(key(h.id,date)) || 0)>=Number(goal.metric_target) : done.has(key(h.id,date)));
        if(fulfilled){count++;streak++;best=Math.max(best,streak);}
        else if(date<today) streak=0;
    }
    // A goal to achieve a streak stays achieved once the required streak occurred.
    const achieved=goal.progress_mode==="streak"?best:count;
    return {progress:Math.min(100,Math.round(achieved/target*10000)/100),achieved_days:achieved};
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

export async function readActivityProgress(supabase,goal,habitIds) {
    if(!habitIds.length) return {progress:0,achieved_days:0};
    const {data:habits,error}=await supabase.from("habits")
        .select("id,start_date,end_date,periodicity,chosen_days,cycle_days_active,cycle_days_rest")
        .eq("user_id",goal.owner_id).in("id",habitIds);
    if(error) throw error;
    const ids=(habits || []).map(h=>h.id);
    if(!ids.length) return {progress:0,achieved_days:0};
    const start=goalDay(goal.created_at),today=goalDay(new Date());
    const [completed,planned,timers,counters]=await Promise.all([
        allRows(()=>supabase.from("habit_completions").select("id,habit_id,completed_at").eq("user_id",goal.owner_id).in("habit_id",ids).gte("completed_at",start).lte("completed_at",today)),
        allRows(()=>supabase.from("habit_planned").select("id,habit_id,planned_at").in("habit_id",ids).gte("planned_at",start).lte("planned_at",today)),
        goal.progress_mode==="daily_timer"?allRows(()=>supabase.from("habit_timers").select("id,habit_id,started_at,end_at,status,pauses").eq("user_id",goal.owner_id).eq("status","ended").in("habit_id",ids).gte("end_at",start+"T00:00:00+03:00")):Promise.resolve([]),
        goal.progress_mode==="daily_counter"?allRows(()=>supabase.from("habit_counters").select("id,habit_id,created_at,count").eq("user_id",goal.owner_id).in("habit_id",ids).gte("created_at",start+"T00:00:00+03:00")):Promise.resolve([])
    ]);
    return activityGoalProgress(goal,habits || [],completed,planned,timers,today,counters);
}
