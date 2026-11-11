import test from "node:test";
import assert from "node:assert/strict";
import { validateOneOffPlanInput } from "../routes/plans/plans.js";

const base = { name: "One-time meeting", plan_date: "2026-11-20" };

test("one-off plans accept date without time", () => {
    assert.deepEqual(validateOneOffPlanInput(base, true), {
        ...base, kind: "personal", completion_mode: "personal",
        timezone: "Europe/Moscow", visibility: "nobody", join_mode: "invite"
    });
});
test("invalid dates and time formats are rejected", () => {
    assert.equal(validateOneOffPlanInput({ ...base, plan_date: "2026-02-30" }, true), null);
    assert.equal(validateOneOffPlanInput({ ...base, start_time: "24:01" }, true), null);
    assert.equal(validateOneOffPlanInput({ ...base, start_time: "14:00", end_time: "13:59" }, true), null);
});
test("shared plans support either completion mode", () => {
    for (const mode of ["personal", "shared"]) {
        assert.equal(validateOneOffPlanInput({ ...base, kind:"shared", completion_mode:mode }, true)?.completion_mode, mode);
    }
    assert.equal(validateOneOffPlanInput({ ...base, kind:"personal", completion_mode:"shared" }, true), null);
});
test("arbitrary fields and long names cannot be inserted", () => {
    assert.equal(validateOneOffPlanInput({ ...base, owner_id:"someone-else" }, true), null);
    assert.equal(validateOneOffPlanInput({ ...base, name:"x".repeat(161) }, true), null);
    assert.equal(validateOneOffPlanInput({ ...base, timezone:"Mars/Phobos" }, true), null);
});
test("partial updates cannot change ownership or type", () => {
    assert.deepEqual(validateOneOffPlanInput({ name:"  Renamed plan  " }), { name:"Renamed plan" });
    assert.equal(validateOneOffPlanInput({ created_at:"2026-01-01" }), null);
});


import registerPlans from "../routes/plans/plans.js";

const owner = "11111111-1111-4111-8111-111111111111";
const outsider = "22222222-2222-4222-8222-222222222222";

function mockedPlanServer(membershipStatus = null) {
    let writes = 0;
    const data = {
        one_off_plans: [{
            id:1,owner_id:owner,name:"Private appointment",description:"PRIVATE PLAN BODY",
            plan_date:"2026-11-20",start_time:null,timezone:"Europe/Moscow",
            kind:"shared",completion_mode:"personal",status:"upcoming"
        }],
        one_off_plan_members: membershipStatus ? [{ plan_id:1,user_id:outsider,status:membershipStatus }] : []
    };
    const supabase = { from(table) {
        const filters = [];
        const query = {
            select() { return query; },
            eq(column,value) { filters.push(row => String(row[column]) === String(value)); return query; },
            maybeSingle() {
                const item = (data[table] || []).find(row => filters.every(f => f(row)));
                return Promise.resolve({ data:item || null,error:null });
            },
            update() { writes++; return query; },
            insert() { writes++; return query; },
            upsert() { writes++; return query; },
            delete() { writes++; return query; }
        };
        return query;
    }};
    const routes = new Map();
    const app = {};
    for (const method of ["get","post","patch","delete"]) {
        app[method] = (path,...handlers) => routes.set(method.toUpperCase() + " " + path,handlers.at(-1));
    }
    registerPlans(app,supabase);
    return { routes, getWrites:() => writes };
}

async function callPlanRoute(server,method,path,userId,body = {}) {
    const handler = server.routes.get(method + " " + path);
    let status = 200;
    let payload = null;
    const res = {
        status(value) { status = value; return res; },
        json(value) { payload = value; return res; }
    };
    await handler({ user:userId ? {id:userId} : null,params:{id:"1"},body },res);
    return { status,payload };
}
test("nonmembers cannot read, edit or complete private plans", async () => {
    const app = mockedPlanServer();
    const read = await callPlanRoute(app,"GET","/plans/:id",outsider);
    assert.equal(read.status,404);
    assert.equal(JSON.stringify(read.payload).includes("PRIVATE PLAN BODY"),false);
    const edit = await callPlanRoute(app,"PATCH","/plans/:id",outsider,{name:"Hijack"});
    assert.equal(edit.status,404);
    const complete = await callPlanRoute(app,"POST","/plans/:id/complete",outsider,{completed:true});
    assert.equal(complete.status,404);
    assert.equal(app.getWrites(),0);
});
test("a pending invite cannot read private description before accepting", async () => {
    const app = mockedPlanServer("pending");
    const result = await callPlanRoute(app,"GET","/plans/:id",outsider);
    assert.equal(result.status,200);
    assert.equal(result.payload.plan.membership_status,"pending");
    assert.equal(Object.hasOwn(result.payload.plan,"description"),false);
});
test("unauthenticated requests are rejected before database reads", async () => {
    const app = mockedPlanServer();
    const result = await callPlanRoute(app,"GET","/plans/:id",null);
    assert.equal(result.status,401);
    assert.equal(app.getWrites(),0);
});
