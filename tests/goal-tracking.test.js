import test from "node:test";
import assert from "node:assert/strict";
import {trackedDayCount,minutesByDay} from "../utils/goalTracking.js";
import {validateGoal,goalProgress} from "../utils/goalWorkspace.js";
const habit={start_date:"2026-11-02",periodicity:"weekly",chosen_days:[1,3,5]};
const goal={progress_mode:"streak",tracking_start:"2026-11-02",tracking_timezone:"UTC",tracking_days:4,tracking_minutes:120};
const dates=(...days)=>days.map(completed_at=>({completed_at}));
test("rest days do not interrupt streak; a missed scheduled day does",()=>{
    const options={completions:dates("2026-11-02","2026-11-04","2026-11-06"),now:new Date("2026-11-08T12:00:00Z")};
    assert.equal(trackedDayCount(goal,habit,options),3);
    assert.equal(trackedDayCount(goal,habit,{...options,now:new Date("2026-11-10T12:00:00Z")}),0);
    assert.equal(trackedDayCount({...goal,progress_mode:"days"},habit,{...options,now:new Date("2026-11-10T12:00:00Z")}),3);
    assert.equal(goalProgress(goal,[],3),75);
});
test("timer subtracts pause, merges overlaps, splits midnight, ignores running",()=>{
    const t=[{status:"ended",started_at:"2026-11-02T22:00:00Z",end_at:"2026-11-03T01:00:00Z",pauses:[{start:"2026-11-02T22:30:00Z",end:"2026-11-02T23:00:00Z"}]},
        {status:"ended",started_at:"2026-11-02T23:00:00Z",end_at:"2026-11-03T00:00:00Z"},
        {status:"running",started_at:"2026-11-02T10:00:00Z",end_at:"2026-11-02T22:00:00Z"}];
    const minutes=minutesByDay(t,"UTC");
    assert.equal(minutes.get("2026-11-02"),90);
    assert.equal(minutes.get("2026-11-03"),60);
    assert.equal(trackedDayCount({...goal,progress_mode:"daily_timer",tracking_minutes:90}, {...habit,periodicity:"everyday"}, {timers:t,now:new Date("2026-11-02T23:59:00Z")}),1);
});
test("automatic configuration validates source, date, timezone and positive days",()=>{
    const fields={name:"Yoga",progress_mode:"daily_timer",tracking_habit_id:5,tracking_start:"2026-11-24",tracking_timezone:"Europe/Warsaw",tracking_days:30,tracking_minutes:120};
    assert.ok(validateGoal(fields));
    assert.equal(validateGoal({...fields,tracking_days:0}),null);
    assert.equal(validateGoal({...fields,tracking_habit_id:null}),null);
    assert.equal(validateGoal({...fields,tracking_timezone:"invalid"}),null);
});
