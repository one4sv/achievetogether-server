import test from "node:test";
import assert from "node:assert/strict";
import {activityGoalProgress,timerSeconds,dayStart,goalDay} from "../utils/activityGoalProgress.js";
const h={id:1,start_date:"2026-11-20",periodicity:"weekly",chosen_days:[1,3,5]};
const g={created_at:"2026-11-20T00:00:00+03:00",target_days:2,progress_mode:"streak"};
const completed=["2026-11-20","2026-11-23"].map(completed_at=>({habit_id:1,completed_at}));
test("weekend is not a streak break",()=>assert.equal(activityGoalProgress(g,[h],completed,[],[],"2026-11-24").progress,100));
test("missed scheduled day breaks streak",()=>assert.equal(activityGoalProgress(g,[h],[completed[0],{habit_id:1,completed_at:"2026-11-25"}],[],[],"2026-11-26").progress,50));
test("timer excludes pauses and counts only stopped sessions",()=>{
 const timer={habit_id:1,status:"ended",started_at:"2026-11-20T10:00:00+03:00",end_at:"2026-11-20T12:30:00+03:00",pauses:[{start:"2026-11-20T11:00:00+03:00",end:"2026-11-20T11:30:00+03:00"}]};
 assert.equal(timerSeconds(timer,"2026-11-20"),7200);
 assert.equal(activityGoalProgress({...g,progress_mode:"daily_timer",daily_minutes:120},[h],[],[],[timer],"2026-11-20").progress,50);
 assert.equal(timerSeconds({...timer,status:"running"},"2026-11-20"),0);
});
test("cycle rest and sometimes explicit plans",()=>{
 const cycle={...h,periodicity:"cycle",cycle_days_active:1,cycle_days_rest:2};
 assert.equal(activityGoalProgress(g,[cycle],completed,[],[],"2026-11-24").progress,100);
 const sometimes={...h,periodicity:"sometimes"};
 assert.equal(activityGoalProgress(g,[sometimes],completed,[],[],"2026-11-24").progress,100);
});

test("civil date boundaries handle DST, and timer progress separates today from overall",()=>{
    assert.equal(dayStart("2026-03-30","Europe/Stockholm")-dayStart("2026-03-29","Europe/Stockholm"),23*3600000);
    assert.equal(dayStart("2026-10-26","Europe/Stockholm")-dayStart("2026-10-25","Europe/Stockholm"),25*3600000);
    assert.equal(goalDay("2026-11-20T22:30:00Z","Europe/Stockholm"),"2026-11-20");
    const goal={...g,progress_mode:"daily_timer",daily_minutes:120};
    const timer={habit_id:1,status:"running",started_at:"2026-11-20T10:00:00Z",pauses:[]};
    const result=activityGoalProgress(goal,[h],[],[],[timer],"2026-11-20",[],"Europe/Stockholm",Date.parse("2026-11-20T11:00:00Z"));
    assert.equal(result.progress,0);
    assert.equal(result.today_progress,50);
});
test("undo and schedule changes recompute rather than accumulate cached progress",()=>{
    assert.equal(activityGoalProgress(g,[h],completed,[],[],"2026-11-24").progress,100);
    assert.equal(activityGoalProgress(g,[h],completed.slice(0,1),[],[],"2026-11-24").progress,50);
    assert.equal(activityGoalProgress(g,[{...h,chosen_days:[3]}],completed,[],[],"2026-11-24").progress,0);
});

test("total timer accumulates ended sessions across days, excludes pauses and clips deadline",()=>{
    const goal={...g,progress_mode:"total_timer",metric_target:240,due_date:"2026-11-21"};
    const timer={habit_id:1,status:"ended",started_at:"2026-11-20T23:00:00+03:00",end_at:"2026-11-21T02:00:00+03:00",pauses:[{start:"2026-11-21T00:00:00+03:00",end:"2026-11-21T01:00:00+03:00"}]};
    const late={...timer,started_at:"2026-11-21T23:00:00+03:00",end_at:"2026-11-22T02:00:00+03:00",pauses:[]};
    const running={...timer,status:"running"};
    const result=activityGoalProgress(goal,[h],[],[],[timer,late,running,{...timer,habit_id:2}],"2026-11-22",[],"Europe/Moscow",Date.parse("2026-11-22T12:00:00+03:00"));
    assert.equal(result.achieved_minutes,180);
    assert.equal(result.progress,75);
});
