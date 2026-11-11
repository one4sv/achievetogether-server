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
    await handler({ user:userId ? {id:userId} : null,params:{id:"1",memberId:outsider},body },res);
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

test("plan descriptions are limited to 1200 characters", () => {
    assert.equal(validateOneOffPlanInput({ ...base, description: "x".repeat(1200) }, true)?.description.length, 1200);
    assert.equal(validateOneOffPlanInput({ ...base, description: "x".repeat(1201) }, true), null);
    assert.equal(validateOneOffPlanInput({ description: "x".repeat(1201) }), null);
});


test("one-off plan comments are inaccessible to nonmembers", async () => {
    const app = mockedPlanServer();
    const get = await callPlanRoute(app,"GET","/plans/:id/comment",outsider);
    const write = await callPlanRoute(app,"POST","/plans/:id/comment",outsider,{comment:"private"});
    assert.equal(get.status,404);
    assert.equal(write.status,404);
    assert.equal(app.getWrites(),0);
});
test("pending invite cannot read or write plan comments", async () => {
    const app = mockedPlanServer("pending");
    const get = await callPlanRoute(app,"GET","/plans/:id/comment",outsider);
    const write = await callPlanRoute(app,"POST","/plans/:id/comment",outsider,{comment:"pending"});
    assert.equal(get.status,403);
    assert.equal(write.status,403);
    assert.equal(app.getWrites(),0);
});
test("plan comment rejects texts longer than 200 characters", async () => {
    const app = mockedPlanServer();
    const result = await callPlanRoute(app,"POST","/plans/:id/comment",owner,{comment:"x".repeat(201)});
    assert.equal(result.status,400);
    assert.equal(app.getWrites(),0);
});


test("plan tag is optional, follows activity tag keys, and can be updated or cleared", () => {
    assert.equal(validateOneOffPlanInput(base,true).tag, undefined);
    assert.equal(validateOneOffPlanInput({ ...base, tag:"work" },true)?.tag,"work");
    assert.deepEqual(validateOneOffPlanInput({tag:null}),{tag:null});
    assert.deepEqual(validateOneOffPlanInput({tag:"coding"}),{tag:"coding"});
    assert.equal(validateOneOffPlanInput({ ...base, tag:"<script>" },true),null);
    assert.equal(validateOneOffPlanInput({tag:"invalid-tag"}),null);
});

// Inviting from the participant section is what promotes a new personal plan.
test("personal plans can be promoted on the first invite without exposing them to nonmembers", async () => {
    const app = mockedPlanServer();
    const blocked = await callPlanRoute(app,"POST","/plans/:id/invite",outsider,{ nick:"someone" });
    // Conceal the existence of private plans from nonmembers.
    assert.equal(blocked.status,404);
    assert.equal(app.getWrites(),0);
});

test("plan member removal is owner-only and never removes its owner", async () => {
    const app = mockedPlanServer("accepted");
    const notOwner = await callPlanRoute(app,"DELETE","/plans/:id/members/:memberId",outsider);
    assert.equal(notOwner.status,403);
    const notLoggedIn = await callPlanRoute(app,"DELETE","/plans/:id/members/:memberId",null);
    assert.equal(notLoggedIn.status,401);
    assert.equal(app.getWrites(),0);
});

test("owner invitation upgrades a personal plan, exposes pending status only to the owner and supports withdrawal", async () => {
    const targetId = "33333333-3333-4333-8333-333333333333";
    const rows = {
        one_off_plans: [{
            id: 1, owner_id: owner, name: "Private appointment", description: "Private notes",
            plan_date: "2026-11-20", start_time: null, timezone: "Europe/Moscow",
            kind: "personal", completion_mode: "personal", status: "upcoming"
        }],
        one_off_plan_members: [{ plan_id: 1, user_id: owner, status: "accepted" }],
        one_off_plan_completions: [],
        one_off_plan_comments: [],
        users: [
            { id: owner, nick: "owner", username: "Owner", avatar_url: null },
            { id: targetId, nick: "target", username: "Target", avatar_url: null }
        ],
        chat_members: [
            { chat_id: 12, user_id: owner, is_blocked: false, "chats.is_group": false },
            { chat_id: 12, user_id: targetId, is_blocked: false, "chats.is_group": false }
        ],
        settings: [{ user_id: targetId, private: { plan_invites: "contacts" } }]
    };
    const supabase = { from(table) {
        let action = "select";
        let values = null;
        const predicates = [];
        const query = {
            select() { return query; },
            eq(column, value) { predicates.push(row => String(row[column]) === String(value)); return query; },
            in(column, values) { predicates.push(row => values.map(String).includes(String(row[column]))); return query; },
            maybeSingle() {
                return Promise.resolve({ data: (rows[table] || []).find(row => predicates.every(f => f(row))) || null, error: null });
            },
            update(value) { action = "update"; values = value; return query; },
            upsert(value) { action = "upsert"; values = value; return query; },
            delete() { action = "delete"; return query; },
            then(resolve, reject) {
                const matching = (rows[table] || []).filter(row => predicates.every(f => f(row)));
                if (action === "update") matching.forEach(row => Object.assign(row, values));
                if (action === "upsert") rows[table].push({ ...values });
                if (action === "delete") rows[table] = rows[table].filter(row => !matching.includes(row));
                return Promise.resolve({ data: matching, error: null }).then(resolve, reject);
            }
        };
        return query;
    }};
    const routes = new Map();
    const app = {};
    for (const method of ["get", "post", "patch", "delete"]) {
        app[method] = (path, ...handlers) => routes.set(method.toUpperCase() + " " + path, handlers.at(-1));
    }
    registerPlans(app, supabase);
    const send = await callPlanRoute({ routes }, "POST", "/plans/:id/invite", owner, { nick: "target" });
    assert.equal(send.status, 200);
    assert.equal(rows.one_off_plans[0].kind, "shared");
    const details = await callPlanRoute({ routes }, "GET", "/plans/:id", owner);
    assert.equal(details.payload.plan.members.find(member => member.id === targetId)?.status, "pending");
    assert.equal(details.payload.plan.participants_count, 1);
    const remove = await callPlanRoute({ routes }, "DELETE", "/plans/:id/members/:memberId", owner);
    assert.equal(remove.status, 200);
    assert.equal(rows.one_off_plan_members.some(member => member.user_id === targetId), false);
});
