import test from "node:test";
import assert from "node:assert/strict";
import registerPlans from "../routes/plans/plans.js";

const owner = "11111111-1111-4111-8111-111111111111";
const stranger = "22222222-2222-4222-8222-222222222222";
const planToken = "33333333-3333-4333-8333-333333333333";
const profileToken = "44444444-4444-4444-8444-444444444444";

function makeApp(visibility, overall = "nobody") {
    const rows = {
        one_off_plans: [{
            id:7,owner_id:owner,name:"Private details",description:"Private description",
            plan_date:"2026-11-20",start_time:null,end_time:null,timezone:"Europe/Moscow",place:"",
            kind:"personal",status:"upcoming",visibility,share_token:planToken
        }],
        settings: [{ user_id:owner,private:{ plans:overall },profile_share_token:profileToken }],
        one_off_plan_members:[],
        chat_members:[],chats:[]
    };
    const supabase = { from(table) {
        let predicates = [];
        let selection = "*";
        const query = {
            select(columns) { selection = columns; return query; },
            eq(column,value) { predicates.push(row => String(row[column]) === String(value)); return query; },
            in(column,values) { predicates.push(row => values.map(String).includes(String(row[column]))); return query; },
            async maybeSingle() {
                const row = (rows[table] || []).find(item => predicates.every(p => p(item)));
                return { data: row ? { ...row } : null,error:null };
            }
        };
        return query;
    }};
    const routes = new Map();
    const app = {};
    for (const name of ["get","post","patch","delete"])
        app[name] = (key,...handlers) => routes.set(name.toUpperCase() + " " + key,handlers.at(-1));
    registerPlans(app,supabase);
    const request = async (share,userId = null) => {
        const handler = routes.get("GET /plans/:id");
        let status = 200, payload;
        const res = { status(code) { status = code;return res; },json(value) { payload = value;return res; } };
        await handler({ params:{id:"7"},query:share ? {share} : {},user:userId ? {id:userId} : null },res);
        return { status,payload };
    };
    return {request,rows};
}

test("all plans are publicly readable but secrets and member details are not returned",async () => {
    const app = makeApp("all");
    const {status,payload} = await app.request();
    assert.equal(status,200);
    assert.equal(payload.plan.name,"Private details");
    for (const forbidden of ["owner_id","share_token","members","comments","completed_for_me"])
        assert.equal(Object.hasOwn(payload.plan,forbidden),false,forbidden);
    assert.equal(payload.plan.membership_status,"viewer");
});

test("private and contacts-only plans do not disclose their existence to anonymous visitors",async () => {
    for (const visibility of ["nobody","contacts"])
        assert.equal((await makeApp(visibility).request()).status,404);
});

test("an explicitly link-only plan requires its own token",async () => {
    const app = makeApp("link");
    assert.equal((await app.request()).status,404);
    assert.equal((await app.request(profileToken)).status,404);
    assert.equal((await app.request("not-a-token")).status,404);
    assert.equal((await app.request(planToken)).status,200);
});

test("inherited global link-only plan accepts profile token, not bare ID",async () => {
    const app = makeApp("inherit","link");
    assert.equal((await app.request()).status,404);
    assert.equal((await app.request(profileToken)).status,200);
    assert.equal((await app.request(planToken)).status,200);
});

test("explicit nobody overrides public global settings",async () => {
    assert.equal((await makeApp("nobody","all").request()).status,404);
    assert.equal((await makeApp("inherit","all").request()).status,200);
});
