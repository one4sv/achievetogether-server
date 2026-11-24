import test from "node:test";
import assert from "node:assert/strict";
import registerGoalWorkspace from "../routes/goals/workspace.js";

const owner="11111111-1111-4111-8111-111111111111";
const outsider="22222222-2222-4222-8222-222222222222";

function mock() {
    let writes=0;
    const rows={at_goals:[{id:1,owner_id:owner,name:"Private result",description:"PRIVATE GOAL DESCRIPTION",
        progress_mode:"manual",manual_progress:20}],at_goal_stages:[],at_goal_habit_links:[{goal_id:1,habit_id:7}]};
    const supabase={from(table){
        const filters=[];
        const query={
            select(){return query;},
            eq(key,value){filters.push(row=>String(row[key])===String(value));return query;},
            order(){return query;},
            in(key,values){filters.push(row=>values.some(value=>String(row[key])===String(value)));return query;},
            then(resolve,reject){return Promise.resolve({data:(rows[table] || []).filter(row=>filters.every(f=>f(row))),error:null}).then(resolve,reject);},
            maybeSingle(){return Promise.resolve({data:(rows[table] || []).find(row=>
                filters.every(f=>f(row))) || null,error:null});},
            insert(){writes++;return query;},
            update(){writes++;return query;},
            delete(){writes++;return query;},
            upsert(){writes++;return query;}
        };
        return query;
    }};
    const routes=new Map();
    const app={};
    for(const method of ["get","post","patch","delete"]){
        app[method]=(path,...handlers)=>routes.set(method.toUpperCase()+" "+path,handlers.at(-1));
    }
    registerGoalWorkspace(app,supabase);
    const call=async(method,path,user,body={},params={id:"1",stageId:"2",kind:"habit",linkId:"3"})=>{
        let status=200,payload;
        const res={status(value){status=value;return res;},json(value){payload=value;return res;}};
        const fn=routes.get(method+" "+path);
        assert.ok(fn,"Route missing: "+method+" "+path);
        await fn({user:user?{id:user}:null,params,body},res);
        return {status,payload};
    };
    return {call,writes:()=>writes};
}
test("non-owner cannot read, update, delete or link private goals",async()=>{
    const app=mock();
    for(const [method,path,body] of [
        ["GET","/goal-workspace/:id",{}],
        ["PATCH","/goal-workspace/:id",{name:"Hijacked"}],
        ["DELETE","/goal-workspace/:id",{}],
        ["POST","/goal-workspace/:id/stages",{title:"Injected"}],
        ["PATCH","/goal-workspace/:id/stages/:stageId",{completed:true}],
        ["DELETE","/goal-workspace/:id/stages/:stageId",{}],
        ["POST","/goal-workspace/:id/links",{kind:"habit",id:3}],
        ["DELETE","/goal-workspace/:id/links/:kind/:linkId",{}]
    ]){
        const result=await app.call(method,path,outsider,body);
        assert.equal(result.status,404,path);
        assert.equal(JSON.stringify(result.payload).includes("PRIVATE GOAL DESCRIPTION"),false);
    }
    assert.equal(app.writes(),0);
});
test("anonymous requests and owner injection are rejected",async()=>{
    const app=mock();
    assert.equal((await app.call("GET","/goal-workspace/:id",null)).status,401);
    assert.equal((await app.call("POST","/goal-workspace",null,{name:"Goal"})).status,401);
    assert.equal((await app.call("POST","/goal-workspace",owner,{name:"Goal",owner_id:outsider})).status,400);
    assert.equal((await app.call("POST","/goal-workspace/:id/links",owner,{kind:"plan",id:"nan"})).status,400);
    assert.equal(app.writes(),0);
});

test("workspace list exposes activity links only for the goal owner",async()=>{
    const app=mock();
    const own=await app.call("GET","/goal-workspace",owner);
    assert.equal(own.status,200);
    assert.deepEqual(own.payload.goals.map(g=>({id:g.id,habit_ids:g.habit_ids,progress:g.progress})),[{id:1,habit_ids:[7],progress:20}]);
    const other=await app.call("GET","/goal-workspace",outsider);
    assert.equal(other.status,200);
    assert.deepEqual(other.payload.goals,[]);
    assert.equal((await app.call("GET","/goal-workspace",null)).status,401);
});
