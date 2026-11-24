import test from "node:test";
import assert from "node:assert/strict";
import {sharedGoalAccess,validSharedProgressPatch} from "../utils/sharedGoalAccess.js";
test("regular private goal cannot be read by another member",async()=>{
 assert.equal(await sharedGoalAccess({}, {id:1,owner_id:"owner"},"outsider"),null);
 assert.equal((await sharedGoalAccess({}, {id:1,owner_id:"owner"},"owner")).canEdit,true);
});
test("shared member may write progress only",()=>{
 assert.equal(validSharedProgressPatch({manual_progress:30}),true);
 assert.equal(validSharedProgressPatch({status:"completed"}),true);
 assert.equal(validSharedProgressPatch({name:"changed"}),false);
 assert.equal(validSharedProgressPatch({status:"archived"}),false);
});
