import test from "node:test";import assert from "node:assert/strict";import {aggregateGoalCounters} from "../utils/activityGoalProgress.js";
test("shared counter uses per-user daily maximum, not repeated snapshots",()=>{
 const d="2026-11-25T12:00:00Z";
 assert.equal(aggregateGoalCounters([{id:1,habit_id:3,user_id:"a",created_at:d,count:2},{id:2,habit_id:3,user_id:"a",created_at:d,count:4},{id:3,habit_id:3,user_id:"b",created_at:d,count:5}],"UTC")[0].count,9);
});
