import test from "node:test";
import assert from "node:assert/strict";
import {reminderIsDue} from "../services/goalWorker.js";
import {validateGoal} from "../utils/goalWorkspace.js";
test("goal reminders are optional, date based and active only",()=>{
 const goal={status:"active",due_date:"2026-12-01",reminder_days:7};
 assert.equal(reminderIsDue(goal,"2026-11-24"),true);
 assert.equal(reminderIsDue(goal,"2026-11-25"),false);
 assert.equal(reminderIsDue({...goal,status:"completed"},"2026-11-24"),false);
 assert.equal(reminderIsDue({...goal,reminder_days:null},"2026-11-24"),false);
 assert.equal(validateGoal({name:"A",auto_complete:"yes"}),null);
 assert.equal(validateGoal({name:"A",reminder_days:31}),null);
 assert.equal(validateGoal({name:"A",auto_complete:true,reminder_days:0}).auto_complete,true);
});
