import test from "node:test";
import assert from "node:assert/strict";
import registerGoals from "../routes/goals/goals.js";

const owner = "11111111-1111-4111-8111-111111111111";
const stranger = "22222222-2222-4222-8222-222222222222";

function server() {
    const routes = new Map();
    let writes = 0;
    const queryFor = table => {
        const filters = [];
        const query = {
            select() { return query; },
            eq(key, value) { filters.push(row => String(row[key]) === String(value)); return query; },
            maybeSingle() {
                const rows = table === "goals" ? [{
                    id:1,owner_id:owner,name:"Private goal",description:"Secret",
                    progress_mode:"manual",manual_progress:20,metric_share:0.7
                }] : [];
                return Promise.resolve({data:rows.find(row => filters.every(filter => filter(row))) || null,error:null});
            },
            insert() { writes++; return query; },
            update() { writes++; return query; },
            delete() { writes++; return query; },
            upsert() { writes++; return query; }
        };
        return query;
    };
    const app = {};
    for (const method of ["get","post","patch","delete"]) {
        app[method] = (path,...handlers) => routes.set(method.toUpperCase() + " " + path, handlers.at(-1));
    }
    registerGoals(app,{from:queryFor});
    const call = async (method,path,userId,body = {},params = {id:"1"}) => {
        let status = 200, payload;
        const res = {
            status(value) { status = value; return res; },
            json(value) { payload = value; return res; }
        };
        await routes.get(method + " " + path)({user:userId ? {id:userId} : null,body,params},res);
        return {status,payload};
    };
    return {call,writes:() => writes};
}

test("goals cannot be enumerated or modified by a non-owner", async () => {
    const app = server();
    for (const [method,path,body] of [
        ["GET","/goals/:id",{}],
        ["PATCH","/goals/:id",{name:"Hijacked"}],
        ["DELETE","/goals/:id",{}],
        ["POST","/goals/:id/milestones",{title:"Injected"}],
        ["POST","/goals/:id/links",{kind:"plan",id:5}]
    ]) {
        const result = await app.call(method,path,stranger,body);
        assert.equal(result.status,404, method + " " + path);
        assert.equal(JSON.stringify(result.payload).includes("Secret"),false);
    }
    assert.equal(app.writes(),0);
});

test("goal routes reject unauthenticated changes and user id injection", async () => {
    const app = server();
    assert.equal((await app.call("GET","/goals/:id",null)).status,401);
    assert.equal((await app.call("POST","/goals",null,{name:"X"})).status,401);
    assert.equal((await app.call("POST","/goals",owner,{name:"X",owner_id:stranger})).status,400);
    assert.equal(app.writes(),0);
});
