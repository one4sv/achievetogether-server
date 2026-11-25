import test from "node:test";import assert from "node:assert/strict";import {actorFilter,exportRows} from "../routes/habits/export.js";
test("shared completion never falls back to storage owner",()=>{
 assert.equal(actorFilter("a",true),"actor_user_id.eq.a");
 assert.equal(actorFilter("a",false),"actor_user_id.eq.a,and(actor_user_id.is.null,user_id.eq.a)");
});
test("export reads all pages",async()=>{
 const data=Array.from({length:1201},(_,id)=>({id}));
 const result=await exportRows(()=>({order:()=>({range:async(a,b)=>({data:data.slice(a,b+1)})})}));
 assert.equal(result.length,1201);
});
