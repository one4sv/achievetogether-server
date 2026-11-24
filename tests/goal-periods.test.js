import test from "node:test";
import assert from "node:assert/strict";
import { nextPeriod } from "../utils/goalPeriods.js";
import {activityGoalProgress} from "../utils/activityGoalProgress.js";

test("calendar repeat periods use Monday and real month boundaries",()=>{
    assert.equal(nextPeriod("2026-11-25","daily"),"2026-11-26");
    assert.equal(nextPeriod("2026-11-25","weekly"),"2026-11-30");
    assert.equal(nextPeriod("2026-11-30","weekly"),"2026-12-07");
    assert.equal(nextPeriod("2028-02-29","monthly"),"2028-03-01");
    assert.equal(nextPeriod("2026-12-31","monthly"),"2027-01-01");
});
test("automatic progress ignores completions from previous periods",()=>{
    const goal={progress_mode:"days",target_days:1,created_at:"2026-11-20T00:00:00Z",repeat_period_start:"2026-11-25"};
    const habit={id:1,start_date:"2026-11-20",periodicity:"everyday"};
    assert.equal(activityGoalProgress(goal,[habit],[{habit_id:1,completed_at:"2026-11-24"}],[],[],"2026-11-25",[],"UTC").progress,0);
    assert.equal(activityGoalProgress(goal,[habit],[{habit_id:1,completed_at:"2026-11-25"}],[],[],"2026-11-25",[],"UTC").progress,100);
});
