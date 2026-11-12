import test from "node:test";
import assert from "node:assert/strict";
import commentsRoutes from "../routes/posts/comments.js";

const owner = "11111111-1111-4111-8111-111111111111";
const token = "33333333-3333-4333-8333-333333333333";

function createDatabase(visibility) {
    const rows = {
        posts: [{ id: 17, user_id: owner, visibility }],
        settings: [{ user_id: owner, private: { posts: "all" }, profile_share_token: token }],
        posts_comments: [{
            id: 4, post_id: 17, user_id: owner, text: "Visible comment",
            created_at: "2026-11-01T12:00:00Z", files: []
        }],
        users: [{ id: owner, nick: "owner", username: "Post owner", avatar_url: null }],
        post_comment_likes: []
    };
    return {
        from(table) {
            const predicates = [];
            let columns = "*";
            const evaluate = () => (rows[table] || []).filter(row =>
                predicates.every(predicate => predicate(row))).map(row =>
                columns === "*" || columns.startsWith("*,") ? { ...row } :
                    Object.fromEntries(columns.split(",").map(key => key.trim())
                        .filter(key => key in row).map(key => [key,row[key]])));
            const query = {
                select(fields = "*") { columns = fields; return query; },
                eq(key,value) { predicates.push(row => String(row[key]) === String(value)); return query; },
                in(key,values) { predicates.push(row => values.includes(row[key])); return query; },
                order() { return query; },
                maybeSingle() { return Promise.resolve({ data: evaluate()[0] || null, error: null }); },
                then(resolve,reject) { return Promise.resolve({ data: evaluate(), error: null }).then(resolve,reject); }
            };
            return query;
        }
    };
}

async function getComments(visibility,share) {
    const handlers = new Map();
    const app = { get(path,...steps) { handlers.set(path,steps.at(-1)); }, post() {}, patch() {}, delete() {} };
    commentsRoutes(app,createDatabase(visibility));
    let status = 200;
    let payload;
    const res = {
        set() { return res; },
        status(code) { status = code; return res; },
        json(data) { payload = data; return res; }
    };
    await handlers.get("/comments/:id")({
        params: { id: "17" }, query: share ? { share } : {}, user: null
    },res);
    return { status,payload };
}

test("guest reads comments on public posts without a session", async () => {
    const { status,payload } = await getComments("all");
    assert.equal(status,200);
    assert.equal(payload.success,true);
    assert.equal(payload.comments[0].text,"Visible comment");
    assert.equal(payload.comments[0].user.nick,"owner");
});

test("guest reads comments on link-only posts with the same share token", async () => {
    const { status,payload } = await getComments("link",token);
    assert.equal(status,200);
    assert.equal(payload.comments.length,1);
    for (const invalid of [undefined,"invalid"]) {
        const denied = await getComments("link",invalid);
        assert.equal(denied.status,404);
        assert.equal(denied.payload.success,false);
    }
});

test("guest cannot read comments of private posts, even with a link token", async () => {
    for (const share of [undefined,token]) {
        const denied = await getComments("nobody",share);
        assert.equal(denied.status,404);
    }
});
