import test from "node:test";
import assert from "node:assert/strict";
import {activityGoalProgress} from "../utils/activityGoalProgress.js";
import {validateGoal,validateGoalStage} from "../utils/goalWorkspace.js";
test("counter goal counts scheduled days with actual stored counter totals",()=>{
 const g={progress_mode:"daily_counter",metric_target:20,target_days:2,created_at:"2026-11-20T00:00:00+03:00"};
 const h={id:1,start_date:"2026-11-20",periodicity:"everyday"};
 const counts=[{habit_id:1,created_at:"2026-11-20T09:00:00+03:00",count:20},{habit_id:1,created_at:"2026-11-21T09:00:00+03:00",count:19},{habit_id:1,created_at:"2026-11-22T09:00:00+03:00",count:22}];
 assert.equal(activityGoalProgress(g,[h],[],[],[],"2026-11-22",counts).progress,100);
 assert.equal(activityGoalProgress(g,[h],[],[],[],"2026-11-21",counts).progress,50);
 assert.equal(validateGoal({name:"Counter",progress_mode:"daily_counter",metric_target:0}),null);
 assert.equal(validateGoalStage({title:"Stage",weight:1}).weight,1);
});
