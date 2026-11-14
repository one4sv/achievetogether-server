import test from "node:test";
import assert from "node:assert/strict";
import postAssetRoutes from "../routes/system/post-assets.js";
import { signedRows } from "../utils/postContent.js";

const owner = "11111111-1111-4111-8111-111111111111";
const outsider = "22222222-2222-4222-8222-222222222222";
const share = "33333333-3333-4333-8333-333333333333";
const storageOrigin = "https://files.example.test";

function fixture(visibility = "nobody") {
    const post = {
        id: 17, user_id: owner, visibility,
        media: [{
            id: "media-one", name: "photo.jpg", type: "image/jpeg",
            url: storageOrigin + "/storage/v1/object/public/posts/" + owner + "/17/photo.jpg"
        }]
    };
    const comment = {
        id: 8, post_id: 17,
        files: [{ name: "comment.jpg", type: "image/jpeg",
            url: storageOrigin + "/storage/v1/object/public/comments/comments/test.jpg" }]
    };
    const rows = {
        posts: [post],
        settings: [{ user_id: owner, private: { posts: "nobody" }, profile_share_token: share }],
        posts_comments: [comment],
        chat_members: []
    };
    const downloads = [];
    const supabase = {
        from(table) {
            const filters = [];
            const query = {
                select() { return query; },
                eq(column, value) { filters.push(row => String(row[column]) === String(value)); return query; },
                in(column, list) { filters.push(row => list.includes(row[column])); return query; },
                maybeSingle() { return Promise.resolve({ data: (rows[table] || []).find(row => filters.every(fn => fn(row))) || null, error: null }); },
                then(resolve, reject) { return Promise.resolve({ data: (rows[table] || []).filter(row => filters.every(fn => fn(row))), error: null }).then(resolve, reject); }
            };
            return query;
        },
        storage: { from(bucket) {
            return {
                getPublicUrl(path) { return { data: { publicUrl: storageOrigin + "/storage/v1/object/public/" + bucket + "/" + path } }; },
                async download(path) {
                    downloads.push(bucket + ":" + path);
                    return { data: { arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer }, error: null };
                }
            };
        } }
    };
    const routes = new Map();
    postAssetRoutes({ get(path, ...handlers) { routes.set(path, handlers.at(-1)); } }, supabase);
    async function get(kind = "post", { viewer = null, token = null, index = "0", range = null } = {}) {
        const headers = {};
        let status = 200, body = null;
        const response = {
            set(name, value) { headers[name] = value; return response; },
            status(value) { status = value; return response; },
            send(value) { body = value; return response; },
            end() { return response; }
        };
        const path = kind === "post" ? "/post-asset/:postId/:index" : "/comment-asset/:commentId/:index";
        const params = kind === "post" ? { postId: "17", index } : { commentId: "8", index };
        await routes.get(path)({
            params, user: viewer ? { id: viewer } : null, query: token ? { share: token } : {},
            get(name) { return name === "range" ? range : null; }
        }, response);
        return { status, body, headers };
    }
    return { post, comment, rows, downloads, get };
}

test("private and deleted post media denies guest and unrelated users, owner can read", async () => {
    const data = fixture();
    assert.equal((await data.get("post")).status, 404);
    assert.equal((await data.get("post", { viewer: outsider })).status, 404);
    assert.equal(data.downloads.length, 0);
    const own = await data.get("post", { viewer: owner });
    assert.equal(own.status, 200);
    assert.deepEqual([...own.body], [1, 2, 3, 4]);
    assert.equal(own.headers["Cache-Control"], "private, no-store");
    assert.equal(own.headers["X-Content-Type-Options"], "nosniff");
    data.rows.posts.length = 0;
    assert.equal((await data.get("post", { viewer: owner })).status, 404);
});

test("public media is readable by guests but immediately blocks old URLs when post is closed", async () => {
    const data = fixture("all");
    assert.equal((await data.get("post")).status, 200);
    data.post.visibility = "nobody";
    assert.equal((await data.get("post")).status, 404);
    assert.equal(data.downloads.length, 1);
});

test("link-only media requires token and rechecks after privacy change", async () => {
    const data = fixture("link");
    assert.equal((await data.get("post")).status, 404);
    assert.equal((await data.get("post", { token: "wrong" })).status, 404);
    assert.equal((await data.get("post", { token: share })).status, 200);
    data.post.visibility = "nobody";
    assert.equal((await data.get("post", { token: share })).status, 404);
});

test("comments inherit parent post privacy, including public and changed privacy", async () => {
    const data = fixture("nobody");
    assert.equal((await data.get("comment")).status, 404);
    assert.equal((await data.get("comment", { viewer: owner })).status, 200);
    data.post.visibility = "all";
    assert.equal((await data.get("comment")).status, 200);
    data.post.visibility = "nobody";
    assert.equal((await data.get("comment")).status, 404);
});

test("file indices and storage origins cannot bypass media authorization", async () => {
    const data = fixture("all");
    assert.equal((await data.get("post", { index: "99" })).status, 404);
    data.post.media[0].url = "https://another.example/storage/v1/object/public/posts/" + owner + "/17/photo.jpg";
    assert.equal((await data.get("post")).status, 404);
    data.post.media[0].url = storageOrigin + "/storage/v1/object/public/posts/" + owner + "/18/photo.jpg";
    assert.equal((await data.get("post")).status, 404);
    assert.equal(data.downloads.length, 0);
});

test("Range supports video streaming and rejects out-of-bounds ranges", async () => {
    const data = fixture("all");
    const part = await data.get("post", { range: "bytes=1-2" });
    assert.equal(part.status, 206);
    assert.equal(part.headers["Content-Range"], "bytes 1-2/4");
    assert.deepEqual([...part.body], [2, 3]);
    const bad = await data.get("post", { range: "bytes=10-20" });
    assert.equal(bad.status, 416);
});

test("API list media maintains id and passes link access to protected URLs", async () => {
    const data = fixture("link");
    const [row] = await signedRows({}, [data.post], "media", "posts", share);
    assert.equal(row.media[0].id, "media-one");
    assert.equal(row.media[0].url, "/api/post-asset/17/0?share=" + share);
});
