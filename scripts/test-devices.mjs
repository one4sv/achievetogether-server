import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import deviceRoutes from '../routes/auth/devices.js';
import postRoute from '../routes/posts/post.js';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-key-that-is-never-used-in-production';
process.env.CLIENT_URL = 'http://localhost:5173';
const userId = randomUUID();
const tables = { users: [{ id: userId, nick: 'test', username: 'Test' }], settings: [{ user_id: userId, private: { posts: 'nobody' } }], posts: [{id: 1, user_id: userId, text: 'private', media: [], likes: []}], at_qr_logins: [], at_trusted_devices: [] };
const db = { from(name) {
    let mode = 'select', value, singular = false;
    const filters = [];
    const q = {
        select() { return q; },
        insert(v) { mode = 'insert'; value = v; return q; },
        update(v) { mode = 'update'; value = v; return q; },
        delete() { mode = 'delete'; return q; },
        eq(k,v) { filters.push(r=>String(r[k])===String(v)); return q; },
        is(k,v) { filters.push(r=>(r[k] ?? null)===v); return q; },
        not(k,op,v) { filters.push(r=>(r[k] ?? null)!==v); return q; },
        gt(k,v) { filters.push(r=>r[k]>v); return q; },
        lt(k,v) { filters.push(r=>r[k]<v); return q; },
        in(k,v) { filters.push(r=>v.includes(r[k])); return q; },
        single() { singular = true; return q; },
        maybeSingle() { singular = true; return q; },
        then(resolve) {
            let rows = tables[name].filter(r=>filters.every(f=>f(r)));
            if(mode === 'insert') { const row = { id: randomUUID(), user_id: null, ...value }; tables[name].push(row); rows = [row]; }
            if(mode === 'update') rows.forEach(r=>Object.assign(r,value));
            if(mode === 'delete') tables[name] = tables[name].filter(r=>!rows.includes(r));
            return Promise.resolve({data: singular ? rows[0] ?? null : rows.map(r=>({...r})),error:null}).then(resolve);
        }
    }; return q;
} };
const routes = [];
const app = Object.fromEntries(['get','post','delete'].map(method => [method,(path,...handlers)=>routes.push({method:method.toUpperCase(),path,handlers})]));
deviceRoutes(app,db); postRoute(app,db);
const auth = `token=${jwt.sign({id:userId},process.env.JWT_SECRET)}`;
const call = async (path,method='GET',body,cookie='',origin=process.env.CLIENT_URL) => {
    const route = routes.find(r=>r.method===method && new RegExp('^'+r.path.replace(/:[^/]+/g,'([^/]+)')+'$').test(path));
    if (!route) throw Error('Unknown test route '+path);
    const params = {}; route.path.split('/').forEach((part,i)=>{ if(part.startsWith(':')) params[part.slice(1)] = path.split('/')[i]; });
    const req = {method,path,params,ip:'test',body:body||{},cookies:Object.fromEntries(cookie.split('; ').filter(Boolean).map(c=>c.split('='))),get:name=>name==='origin'?origin:name==='user-agent'?'Test Browser':undefined};
    const result = {status:200,data:null,cookie:''}; let finished = false;
    const res = { set(){return res;},status(n){result.status=n;return res;},json(data){result.data=data;finished=true;return res;},cookie(name,value){result.cookie += (result.cookie?'; ':'')+name+'='+value;return res;},clearCookie(){return res;} };
    for(const handler of route.handlers) { await handler(req,res,error=>{if(error) throw error;}); if(finished) break; }
    return result;
};
try {
    assert.equal((await call('/auth/qr','POST',{},'','https://evil.example')).status,403);
    const qr = await call('/auth/qr','POST',{}); assert.equal(qr.status,200);
    assert.equal((await call('/auth/qr/'+qr.data.id)).status,410);
    assert.equal((await call('/auth/qr/approve','POST',{claim:qr.data.claim,code:qr.data.code})).status,401);
    assert.equal((await call('/auth/qr/consume','POST',{id:qr.data.id},qr.cookie)).status,410);
    assert.equal((await call('/auth/qr/inspect','POST',{claim:qr.data.claim},auth)).data.code,qr.data.code);
    assert.equal((await call('/auth/qr/approve','POST',{claim:qr.data.claim,code:'000000'},auth)).status,410);
    assert.equal((await call('/auth/qr/approve','POST',{claim:qr.data.claim,code:qr.data.code},auth)).status,200);
    const consumes = await Promise.all([call('/auth/qr/consume','POST',{id:qr.data.id},qr.cookie),call('/auth/qr/consume','POST',{id:qr.data.id},qr.cookie)]);
    assert.deepEqual(consumes.map(r=>r.status).sort(),[200,410]);
    const expired = await call('/auth/qr','POST',{}); tables.at_qr_logins.find(r=>r.id===expired.data.id).expires_at='2000-01-01';
    assert.equal((await call('/auth/qr/approve','POST',{claim:expired.data.claim,code:expired.data.code},auth)).status,410);
    assert.equal((await call('/auth/device','POST',{})).status,401);
    const enrolled = await call('/auth/device','POST',{},auth); assert.equal(enrolled.status,200);
    assert.equal((await call('/auth/device','GET',undefined,enrolled.cookie)).data.account.nick,'test');
    const logged = await call('/auth/device/login','POST',{},enrolled.cookie); assert.equal(logged.status,200);
    assert.equal((await call('/auth/device/login','POST',{},enrolled.cookie)).status,401);
    assert.equal((await call('/auth/device','DELETE',{},logged.cookie)).status,200);
    assert.equal((await call('/auth/device/login','POST',{},logged.cookie)).status,401);
    assert.equal((await call('/post/1')).status,404);
    assert.equal((await call('/post/1','GET',undefined,auth)).status,200);
    assert.equal((await call('/post/999','GET',undefined,auth)).status,404);
    console.log('PASS: origin, ownership, confirmation, wrong code, expiration, atomic consume, device rotation/revocation, private post, missing post (20 assertions)');
} finally { /* no network or user data used */ }
