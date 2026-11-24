import test from "node:test";
import assert from "node:assert/strict";
import {recentActivityRecords} from "../utils/activityGoalProgress.js";
test("recent timer records exclude pauses and unfinished sessions",()=>{
 const goal={progress_mode:"total_timer",created_at:"2026-11-20T00:00:00Z"};
 const timer={id:1,status:"ended",started_at:"2026-11-24T10:00:00Z",end_at:"2026-11-24T11:00:00Z",pauses:[{start:"2026-11-24T10:15:00Z",end:"2026-11-24T10:30:00Z"}]};
 const records=recentActivityRecords(goal,[],[timer,{...timer,id:2,status:"running"}],[],"UTC",Date.parse("2026-11-25T00:00:00Z"));
 assert.equal(records.length,1);assert.equal(records[0].seconds,2700);
});
