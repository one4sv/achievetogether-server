import test from "node:test";
import assert from "node:assert/strict";
import { requireHabitView, requireHabitPermission } from "../utils/habitAccess.js";
const owner="12345678-1234-1234-1234-123456789abc";
const share="87654321-1234-1234-1234-123456789abc";
function database(rule,ongoing=true){
    const tables={habits:{id:19,user_id:owner,ongoing,completion_mode:"personal"},settings:{show_archived_in_acc:false,private:{habits:rule},profile_share_token:share}};
    return {from(table){const query={select(){return query;},eq(){return query;},async maybeSingle(){return {data:tables[table]||null,error:null};}};return query;},async rpc(){return {data:{is_owner:false,is_member:false,can_complete:false,can_edit_info:false},error:null};}};
}
async function run(middleware,query={}){
    const req={user:null,params:{id:"19"},query};let status=200,next=false;
    const res={status(v){status=v;return res;},json(){return res;}};
    await middleware(req,res,()=>{next=true;});
    return {status,next,access:req.habitAccess};
}
test("public activity calendar and statistics can use guest read ACL",async()=>{
    const result=await run(requireHabitView(database("all")));
    assert.equal(result.next,true);
    assert.equal(result.access.completion_user_id,owner);
    assert.equal(result.access.can_complete,false);
});
test("private, contacts and archived activities remain unavailable to guests",async()=>{
    for(const [rule,ongoing] of [["nobody",true],["contacts",true],["all",false]]) assert.equal((await run(requireHabitView(database(rule,ongoing)))).status,403);
    assert.equal((await run(requireHabitView(database("link")))).status,403);
    assert.equal((await run(requireHabitView(database("link")),{share})).next,true);
});
test("guest read does not authorize a mutation",async()=>{
    assert.equal((await run(requireHabitPermission(database("all"),"complete"))).status,401);
});
