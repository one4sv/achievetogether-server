import { linkedGroupPermission } from "../../utils/hasPermission.js";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { keys, validKey, validPhoto } from "../../utils/activityImages.js";
import { authenticateUser } from "../../middleware/token.js";
import { linkPlanToGroup } from "../../services/planChatLink.js";
import { sendPlanInvitation, readPlanInvitation, publishPlanInvitation } from "../../services/planInvitations.js";
import { sendInvitationError } from "../../services/habitInvitations.js";
import { ownerPrivacy, relationship, permitted } from "../../utils/privacy.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MODES = ["personal", "shared"];
const CHOICES = ["inherit", "nobody", "contacts", "all", "link"];
const JOINS = ["invite", "request", "open"];
const TAGS = new Set(["coding","paint","photo","music","games","dice","health","sleep","walking","food","hockey","cycling","skiing","snowboarding","swimming","pingpong","tennis","bowling","boxing","basketball","running","football","strategy","volleyball","yoga ","sport","study","work"]);

function isDate(value) {
    if (typeof value !== "string" || !DATE.test(value)) return false;
    const date = new Date(value + "T12:00:00Z");
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function isZone(value) {
    if (typeof value !== "string" || value.length > 80) return false;
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
    catch { return false; }
}
export function validateOneOffPlanInput(body, creating = false) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const keys = ["name","description","plan_date","start_time","end_time",
        "timezone","place","tag","kind","completion_mode","visibility","join_mode"];
    if (Object.keys(body).some(key => !keys.includes(key))) return null;
    if (creating && (!body.name || !body.plan_date)) return null;
    const v = {};
    for (const key of keys) if (Object.hasOwn(body, key)) v[key] = body[key];
    if ("name" in v && (typeof v.name !== "string" || !v.name.trim() || v.name.length > 160)) return null;
    if ("name" in v) v.name = v.name.trim();
    if ("description" in v && (typeof v.description !== "string" || v.description.length > 1200)) return null;
    if ("place" in v && (typeof v.place !== "string" || v.place.length > 500)) return null;
    if ("tag" in v && v.tag !== null && !TAGS.has(v.tag)) return null;
    if ("plan_date" in v && !isDate(v.plan_date)) return null;
    if (["start_time","end_time"].some(key => key in v && v[key] !== null && (typeof v[key] !== "string" || !TIME.test(v[key])))) return null;
    if ("timezone" in v && !isZone(v.timezone)) return null;
    if ("kind" in v && !MODES.includes(v.kind)) return null;
    if ("completion_mode" in v && !MODES.includes(v.completion_mode)) return null;
    if ("visibility" in v && !CHOICES.includes(v.visibility)) return null;
    if ("join_mode" in v && !JOINS.includes(v.join_mode)) return null;
    if (creating) {
        v.kind ||= "personal";
        v.completion_mode ||= "personal";
        v.timezone ||= "Europe/Moscow";
        v.visibility ||= "inherit";
        v.join_mode ||= "invite";
        if (v.kind === "personal" && v.completion_mode !== "personal") return null;
    }
    if (v.start_time && v.end_time && v.end_time < v.start_time) return null;
    return v;
}
const validId = id => /^\d+$/.test(String(id)) && Number.isSafeInteger(Number(id)) && Number(id) > 0;
function signedIn(req,res) {
    if (req.user?.id) return true;
    res.status(401).json({ success: false, error: "Требуется авторизация" });
    return false;
}
function failed(res,error) {
    console.error("One-off plans:", error?.code || error?.message || error);
    return res.status(500).json({ success: false, error: "Ошибка обработки плана" });
}
export async function access(supabase,id,userId) {
    if (!validId(id)) return null;
    const { data: plan, error } = await supabase.from("one_off_plans").select("*").eq("id",id).maybeSingle();
    if (error) throw error;
    if (!plan) return null;
    if (plan.owner_id === userId) return { plan, owner: true, status: "accepted" };
    const { data: member, error: memberError } = await supabase.from("one_off_plan_members")
        .select("status").eq("plan_id",id).eq("user_id",userId).maybeSingle();
    if (memberError) throw memberError;
    if (!member || member.status === "declined") return null;
    const rel = await relationship(supabase,userId,plan.owner_id);
    if (rel.blocked) return null;
    return { plan, owner: false, status: member.status };
}
async function details(supabase,entry,userId) {
    const plan = entry.plan;
    if (entry.status === "pending") {
        return { id: plan.id, name: plan.name, plan_date: plan.plan_date,
            start_time: plan.start_time, timezone: plan.timezone,
            kind: plan.kind, membership_status: "pending" };
    }
    const [membersResult,doneResult] = await Promise.all([
        supabase.from("one_off_plan_members").select("user_id,status,pinned").eq("plan_id",plan.id),
        supabase.from("one_off_plan_completions").select("user_id,completed_at").eq("plan_id",plan.id)
    ]);
    if (membersResult.error || doneResult.error) throw membersResult.error || doneResult.error;
    const memberships = (membersResult.data || []).filter(m => m.status === "accepted" || (entry.owner && m.status === "pending"));
    const activeIds = [...new Set(memberships.filter(m => m.status === "accepted").map(m => m.user_id).concat(plan.owner_id))];
    const visibleIds = [...new Set(memberships.map(m => m.user_id).concat(plan.owner_id))];
    const { data: users, error } = await supabase.from("users")
        .select("id,nick,username,avatar_url").in("id",visibleIds);
    if (error) throw error;
    const statuses = new Map(memberships.map(m => [m.user_id,m.status]));
    const completed = new Set((doneResult.data || []).map(c => c.user_id));
    return { ...plan, is_owner: entry.owner, membership_status: entry.status,
        pinned: Boolean((membersResult.data || []).find(m => m.user_id === userId)?.pinned),
        completed_for_me: plan.status === "completed" || completed.has(userId),
        completed_count: plan.status === "completed" ? activeIds.length : activeIds.filter(id => completed.has(id)).length,
        participants_count: activeIds.length,
        members: (users || []).map(u => ({
            ...u, status: statuses.get(u.id) || "accepted", is_owner: u.id === plan.owner_id,
            completed: (statuses.get(u.id) || "accepted") === "accepted" &&
                (plan.status === "completed" || completed.has(u.id))
        })) };
}
export async function publicPlanAccess(supabase,plan,userId,share) {
    const owner = await ownerPrivacy(supabase,plan.owner_id);
    const relation = await relationship(supabase,userId,plan.owner_id);
    return permitted({ rules:owner.rules,field:"plans",viewerId:userId,ownerId:plan.owner_id,
        contact:relation.contact,blocked:relation.blocked,
        override:plan.visibility,share,token:plan.share_token }) ||
        (plan.visibility === "inherit" && owner.rules.plans === "link" &&
            permitted({ rules:owner.rules,field:"plans",viewerId:userId,ownerId:plan.owner_id,
                contact:relation.contact,blocked:relation.blocked,
                override:plan.visibility,share,token:owner.token }));
}
function publicPlan(plan) {
    // Never expose share_token, participant identities or private completion/comments.
    const { id,name,description,plan_date,start_time,end_time,timezone,place,tag,avatar_key,kind,
        completion_mode,status,visibility } = plan;
    return { id,name,description,plan_date,start_time,end_time,timezone,place,tag,avatar_key,kind,
        completion_mode,status,visibility,is_owner:false,membership_status:"viewer" };
}
async function areContacts(supabase,one,two) {
    const { data: mine, error } = await supabase.from("chat_members")
        .select("chat_id,is_blocked,chats!inner(is_group)").eq("user_id",one).eq("chats.is_group",false);
    if (error) throw error;
    const ids = (mine || []).filter(m => !m.is_blocked).map(m => m.chat_id);
    if (!ids.length) return false;
    const { data: theirs, error: secondError } = await supabase.from("chat_members")
        .select("chat_id,is_blocked,chats!inner(is_group)").eq("user_id",two)
        .eq("chats.is_group",false).in("chat_id",ids);
    if (secondError) throw secondError;
    return (theirs || []).some(m => !m.is_blocked);
}
export default function registerPlans(app,supabase) {
    const auth = authenticateUser(supabase);
    const avatarUpload=multer({storage:multer.memoryStorage(),limits:{files:1,fileSize:800000,fields:1,fieldSize:32,parts:3}});
    const commentUpload=multer({storage:multer.memoryStorage(),limits:{files:4,fileSize:800000,fields:4,fieldSize:2048,parts:9}});
    const commentPhotoPath=(id,key)=>"plans/"+id+"/comments/"+key+".jpg";
    const avatarPath=(id,key)=>"plans/"+id+"/"+key+".jpg";

    app.get("/messages/:id/plan-invitation", auth, async(req,res) => {
        if (!signedIn(req,res)) return;
        try {
            const invitation = await readPlanInvitation(supabase, Number(req.params.id), req.user.id);
            if (!invitation) return res.status(404).json({ success:false,error:"Приглашение недоступно" });
            return res.json({ success:true,invitation });
        } catch(error) { return failed(res,error); }
    });

    app.get("/plans",auth,async(req,res) => {
        if (!signedIn(req,res)) return;
        try {
            const [owned,members] = await Promise.all([
                supabase.from("one_off_plans").select("*").eq("owner_id",req.user.id).limit(200),
                supabase.from("one_off_plan_members").select("plan_id,status,pinned").eq("user_id",req.user.id)
                    .in("status",["pending","accepted"]).limit(200)
            ]);
            if (owned.error || members.error) throw owned.error || members.error;
            const own = owned.data || [];
            const ownIds = new Set(own.map(p => String(p.id)));
            const extraIds = (members.data || []).map(m => m.plan_id).filter(id => !ownIds.has(String(id)));
            let extra = [];
            if (extraIds.length) {
                const result = await supabase.from("one_off_plans").select("*").in("id",extraIds);
                if (result.error) throw result.error;
                extra = result.data || [];
            }
            const status = new Map((members.data || []).map(m => [String(m.plan_id),m.status]));
            const pins = new Map((members.data || []).map(m => [String(m.plan_id),Boolean(m.pinned)]));
            const combined = [...own,...extra].map(p => {
                const membership_status = p.owner_id === req.user.id ? "accepted" : status.get(String(p.id));
                if (membership_status === "pending") {
                    return { id: p.id, name: p.name, plan_date: p.plan_date,
                        start_time: p.start_time, timezone: p.timezone,
                        kind: p.kind, membership_status };
                }
                return { ...p,share_token:p.owner_id === req.user.id ? p.share_token : undefined,
                    membership_status, is_owner: p.owner_id === req.user.id,
                    pinned: pins.get(String(p.id)) || false };
            }).sort((a,b) => a.plan_date.localeCompare(b.plan_date));
            const ids = combined.filter(p => p.membership_status === "accepted").map(p => p.id);
            let doneIds = new Set();
            if (ids.length) {
                const { data, error } = await supabase.from("one_off_plan_completions")
                    .select("plan_id").in("plan_id",ids).eq("user_id",req.user.id);
                if (error) throw error;
                doneIds = new Set((data || []).map(c => String(c.plan_id)));
            }
            return res.json({ success: true, plans: combined.map(p => ({
                ...p, completed_for_me: p.status === "completed" || doneIds.has(String(p.id))
            })) });
        } catch(error) { return failed(res,error); }
    });

    app.post("/plans",auth,async(req,res) => {
        if (!signedIn(req,res)) return;
        const v = validateOneOffPlanInput(req.body,true);
        if (!v) return res.status(400).json({ success: false, error: "Некорректные поля плана" });
        try {
            const { data: plan, error } = await supabase.from("one_off_plans")
                .insert({ ...v, owner_id: req.user.id }).select("*").single();
            if (error) throw error;
            const membership = await supabase.from("one_off_plan_members").insert({
                plan_id: plan.id, user_id: req.user.id, status: "accepted", joined_at: new Date().toISOString()
            });
            if (membership.error) {
                await supabase.from("one_off_plans").delete().eq("id",plan.id).eq("owner_id",req.user.id);
                throw membership.error;
            }
            return res.status(201).json({ success: true, plan });
        } catch(error) { return failed(res,error); }
    });

    app.get("/plans/:id",auth,async(req,res) => {
        try {
            const entry = req.user?.id ? await access(supabase,req.params.id,req.user.id) : null;
            if (entry) {
                const data = await details(supabase,entry,req.user.id);
                if (!entry.owner) delete data.share_token;
                return res.json({ success:true,plan:data });
            }
            if (!validId(req.params.id)) return res.status(404).json({ success:false });
            const { data:plan,error } = await supabase.from("one_off_plans")
                .select("*").eq("id",req.params.id).maybeSingle();
            if (error) throw error;
            if (!plan || !(await publicPlanAccess(supabase,plan,req.user?.id,req.query?.share)))
                return res.status(404).json({ success:false });
            return res.json({ success:true,plan:publicPlan(plan) });
        } catch(error) { return failed(res,error); }
    });

    app.get("/plans/:id/avatar/:key",auth,async(req,res)=>{
        const {id,key}=req.params;
        if(!validId(id) || !validKey(key))return res.sendStatus(404);
        try {
            const entry=req.user?.id?await access(supabase,id,req.user.id):null;
            let plan=entry?.plan;
            if(entry && entry.status!=="accepted")return res.sendStatus(404);
            if(!entry){
                const result=await supabase.from("one_off_plans").select("*").eq("id",id).maybeSingle();
                if(result.error)throw result.error;
                plan=result.data;
                if(!plan || !(await publicPlanAccess(supabase,plan,req.user?.id,req.query?.share)))return res.sendStatus(404);
            }
            if(plan.avatar_key!==key)return res.sendStatus(404);
            const {data,error}=await supabase.storage.from("activity-images").download(avatarPath(id,key));
            if(error)throw error;
            res.set({"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}).type("image/jpeg").send(Buffer.from(await data.arrayBuffer()));
        }catch(error){return failed(res,error);}
    });
    app.put("/plans/:id/avatar",auth,async(req,res,next)=>{
        if(!signedIn(req,res))return;
        try {
            const entry=await access(supabase,req.params.id,req.user.id);
            if(!entry?.owner || entry.plan.status==="canceled")return res.sendStatus(403);
            req.planAvatarEntry=entry;
            next();
        }catch(error){return failed(res,error);}
    },avatarUpload.single("avatar"),async(req,res)=>{
        const plan=req.planAvatarEntry.plan;
        if(req.file ? !validPhoto(req.file,512) : req.body?.remove!=="true")return res.sendStatus(400);
        try {
            const key=req.file?randomUUID():null;
            if(key){
                const path=avatarPath(plan.id,key);
                const reserve=await supabase.from("activity_image_cleanup").insert({path,due_at:new Date(Date.now()+86400000).toISOString()});
                if(reserve.error)throw reserve.error;
                const saved=await supabase.storage.from("activity-images").upload(path,req.file.buffer,{contentType:"image/jpeg",upsert:false});
                if(saved.error)throw saved.error;
            }
            let query=supabase.from("one_off_plans").update({avatar_key:key,updated_at:new Date().toISOString()}).eq("id",plan.id).eq("owner_id",req.user.id).neq("status","canceled");
            query=plan.avatar_key?query.eq("avatar_key",plan.avatar_key):query.is("avatar_key",null);
            const {data,error}=await query.select("id").maybeSingle();
            if(error)throw error;
            if(!data)return res.sendStatus(409);
            return res.json({success:true,avatar_key:key});
        }catch(error){return failed(res,error);}
    });

    app.patch("/plans/:id",auth,async(req,res) => {
        if (!signedIn(req,res)) return;
        const v = validateOneOffPlanInput(req.body);
        if (!v || !Object.keys(v).length || "kind" in v) return res.status(400).json({ success: false });
        try {
            const entry = await access(supabase,req.params.id,req.user.id);
            if (!entry) return res.status(404).json({ success: false });
            if (!entry.owner) return res.status(403).json({ success: false });
            if (entry.plan.status === "canceled") return res.status(409).json({ success: false });
            const merged = { ...entry.plan,...v };
            if (merged.kind === "personal" && merged.completion_mode !== "personal") return res.status(400).json({ success: false });
            if (merged.start_time && merged.end_time && merged.end_time < merged.start_time) return res.status(400).json({ success: false });
            if ("completion_mode" in v && v.completion_mode !== entry.plan.completion_mode) {
                const { data, error } = await supabase.from("one_off_plan_completions")
                    .select("user_id").eq("plan_id",entry.plan.id).limit(1);
                if (error) throw error;
                if (data.length || entry.plan.status === "completed") return res.status(409)
                    .json({ success: false, error: "Режим нельзя менять после выполнения" });
            }
            const { data, error } = await supabase.from("one_off_plans")
                .update({ ...v,updated_at:new Date().toISOString() })
                .eq("id",entry.plan.id).eq("owner_id",req.user.id).select("*").single();
            if (error) throw error;
            return res.json({ success: true, plan:data });
        } catch(error) { return failed(res,error); }
    });

    app.patch("/plans/:id/pin",auth,async(req,res) => {
        if (!signedIn(req,res)) return;
        if (typeof req.body?.pinned !== "boolean" || Object.keys(req.body).length !== 1)
            return res.status(400).json({ success: false });
        try {
            const entry = await access(supabase,req.params.id,req.user.id);
            if (!entry) return res.status(404).json({ success: false });
            if (entry.status !== "accepted") return res.status(403).json({ success: false });
            const { data, error } = await supabase.from("one_off_plan_members")
                .update({ pinned: req.body.pinned }).eq("plan_id",entry.plan.id)
                .eq("user_id",req.user.id).eq("status","accepted")
                .select("pinned").maybeSingle();
            if (error) throw error;
            if (!data) return res.status(404).json({ success: false });
            return res.json({ success: true, pinned: data.pinned });
        } catch(error) { return failed(res,error); }
    });

    app.post("/plans/:id/complete",auth,async(req,res) => {
        if (!signedIn(req,res)) return;
        if (typeof req.body?.completed !== "boolean") return res.status(400).json({ success: false });
        try {
            const entry = await access(supabase,req.params.id,req.user.id);
            if (!entry) return res.status(404).json({ success: false });
            if (entry.status !== "accepted") return res.status(403).json({ success: false });
            if (entry.plan.status === "canceled") return res.status(409).json({ success: false });
            if (!await linkedGroupPermission(supabase, entry.plan.chat_id, req.user.id, "plan_complete")) return res.status(403).json({ success:false });
            if (entry.plan.completion_mode === "shared" && !entry.owner) return res.status(403).json({ success: false });
            if (req.body.completed) {
                const { error } = await supabase.from("one_off_plan_completions")
                    .upsert({ plan_id:entry.plan.id,user_id:req.user.id,completed_at:new Date().toISOString() },
                        { onConflict:"plan_id,user_id" });
                if (error) throw error;
            } else {
                const { error } = await supabase.from("one_off_plan_completions")
                    .delete().eq("plan_id",entry.plan.id).eq("user_id",req.user.id).eq("photo_ids","{}");
                if (error) throw error;
            }
            if (entry.plan.completion_mode === "shared") {
                const { error } = await supabase.from("one_off_plans")
                    .update({ status:req.body.completed ? "completed" : "upcoming",updated_at:new Date().toISOString() })
                    .eq("id",entry.plan.id).eq("owner_id",req.user.id);
                if (error) throw error;
            }
            const fresh = await access(supabase,req.params.id,req.user.id);
            return res.json({ success: true, plan: await details(supabase,fresh,req.user.id) });
        } catch(error) { return failed(res,error); }
    });

    app.post("/plans/:id/cancel",auth,async(req,res) => {
        if (!signedIn(req,res)) return;
        try {
            const entry = await access(supabase,req.params.id,req.user.id);
            if (!entry) return res.status(404).json({ success: false });
            if (!entry.owner) return res.status(403).json({ success: false });
            const { error } = await supabase.from("one_off_plans")
                .update({ status:req.body?.cancel === false ? "upcoming" : "canceled",updated_at:new Date().toISOString() })
                .eq("id",entry.plan.id).eq("owner_id",req.user.id);
            if (error) throw error;
            return res.json({ success: true });
        } catch(error) { return failed(res,error); }
    });

    app.patch("/plans/:id/chat",auth,async(req,res) => {
        if (!signedIn(req,res)) return;
        const chatId = Number(req.body?.chat_id);
        if (!Number.isSafeInteger(chatId) || chatId <= 0)
            return res.status(400).json({ success:false,error:"Выберите групповую беседу" });
        try {
            const result = await linkPlanToGroup(supabase, req.params.id, chatId, req.user.id);
            return res.json({ success:true,...result });
        } catch(error) {
            if (error.status) return res.status(error.status).json({ success:false,error:error.message });
            return failed(res,error);
        }
    });

    app.post("/plans/:id/invite",auth,async(req,res) => {
        if (!signedIn(req,res)) return;
        if (typeof req.body?.nick !== "string" || !/^[\w.-]{1,64}$/.test(req.body.nick))
            return res.status(400).json({ success: false });
        try {
            const entry = await access(supabase,req.params.id,req.user.id);
            if (!entry) return res.status(404).json({ success: false });
            if (!entry.owner || entry.plan.status !== "upcoming")
                return res.status(403).json({ success: false });
            const { data: target,error } = await supabase.from("users")
                .select("id").eq("nick",req.body.nick).maybeSingle();
            if (error) throw error;
            if (!target || target.id === req.user.id) return res.status(404).json({ success: false });
            const { rules } = await ownerPrivacy(supabase,target.id);
            const rel = await relationship(supabase,req.user.id,target.id);
            const invites = rules.plan_invites || "contacts";
            const allowed = permitted({ rules:{ ...rules,plan_invites:invites },field:"plan_invites",
                viewerId:req.user.id,ownerId:target.id,contact:rel.contact,blocked:rel.blocked });
            if (!allowed) return res.status(403)
                .json({ success:false,error:"Приглашение запрещено настройками приватности" });
            const result = await sendPlanInvitation(supabase,req.user.id,entry.plan.id,target.id);
            if (result.already_member || result.already_invited)
                return res.status(409).json({ success:false,error:"Участник уже приглашён" });
            return res.json({ success:true,...result });
        } catch(error) {
            if (error.code === "42501" || error.code === "22023") return sendInvitationError(res,error);
            return failed(res,error);
        }
    });

    app.delete("/plans/:id/members/:memberId",auth,async(req,res) => {
        if (!signedIn(req,res)) return;
        const memberId = req.params.memberId;
        if (typeof memberId !== "string" || !/^[0-9a-f-]{36}$/i.test(memberId))
            return res.status(400).json({ success:false });
        try {
            const entry = await access(supabase,req.params.id,req.user.id);
            if (!entry) return res.status(404).json({ success:false });
            if (!entry.owner) return res.status(403).json({ success:false });
            if (entry.plan.status === "canceled") return res.status(409).json({ success:false });
            if (memberId === entry.plan.owner_id) return res.status(403).json({ success:false });
            const { data: existing, error:lookupError } = await supabase.from("one_off_plan_members")
                .select("status,invitation_message_id").eq("plan_id",entry.plan.id).eq("user_id",memberId).maybeSingle();
            if (lookupError) throw lookupError;
            if (!existing || existing.status === "declined")
                return res.status(404).json({ success:false });
            const { error } = await supabase.from("one_off_plan_members")
                .delete().eq("plan_id",entry.plan.id).eq("user_id",memberId);
            if (error) throw error;
            // The removed user no longer has access or a completion/comment in this plan.
            const [completion,comment] = await Promise.all([
                supabase.from("one_off_plan_completions").delete()
                    .eq("plan_id",entry.plan.id).eq("user_id",memberId),
                supabase.from("one_off_plan_comments").delete()
                    .eq("plan_id",entry.plan.id).eq("user_id",memberId)
            ]);
            if (completion.error || comment.error) throw completion.error || comment.error;
            if (existing.invitation_message_id)
                await publishPlanInvitation(supabase,existing.invitation_message_id,true);
            return res.json({ success:true });
        } catch(error) { return failed(res,error); }
    });

    app.post("/plans/:id/respond",auth,async(req,res) => {
        if (!signedIn(req,res)) return;
        if (!["accepted","declined"].includes(req.body?.status) ||
            !Number.isSafeInteger(req.body?.message_id) || req.body.message_id <= 0 ||
            !validId(req.params.id)) return res.status(400).json({ success:false });
        try {
            const { data:result,error } = await supabase.rpc("respond_plan_invitation", {
                p_actor:req.user.id,p_plan:Number(req.params.id),p_status:req.body.status,
                p_message:req.body.message_id
            });
            if (error) return sendInvitationError(res,error);
            if (result.message_id) await publishPlanInvitation(supabase,result.message_id,true);
            return res.json({ success:true,...result });
        } catch(error) { return failed(res,error); }
    });

    app.get("/plans/:id/comment",auth,async(req,res) => {
        if (!signedIn(req,res)) return;
        try {
            const entry = await access(supabase,req.params.id,req.user.id);
            if (!entry) return res.status(404).json({ success:false });
            if (entry.status !== "accepted") return res.status(403).json({ success:false });
            const [{ data: comments,error },{ data: members,error:membersError }] = await Promise.all([
                supabase.from("one_off_plan_comments").select("user_id,comment,updated_at,photo_ids")
                    .eq("plan_id",entry.plan.id).order("updated_at",{ ascending:false }),
                supabase.from("one_off_plan_members").select("user_id,status").eq("plan_id",entry.plan.id)
            ]);
            if (error || membersError) throw error || membersError;
            const allowed = new Set([entry.plan.owner_id,...(members || [])
                .filter(member => member.status === "accepted").map(member => member.user_id)]);
            const active = (comments || []).filter(item => allowed.has(item.user_id));
            const { data: users,error:usersError } = active.length ?
                await supabase.from("users").select("id,nick,username,avatar_url")
                    .in("id",active.map(item => item.user_id)) :
                { data:[],error:null };
            if (usersError) throw usersError;
            res.set("Cache-Control","private, no-store");
            const own=active.find(item => item.user_id === req.user.id);
            return res.json({
                success:true,
                photos:own?.photo_ids || [],text:own?.comment || "",
                comment:own?.comment || "",
                comments:entry.plan.kind === "shared" ? active.map(item => ({
                    ...item, user:(users || []).find(user => user.id === item.user_id) || null
                })) : []
            });
        } catch(error) { return failed(res,error); }
    });

    app.get("/plans/:id/comment-photos/:key",auth,async(req,res)=>{
        if(!signedIn(req,res))return;
        if(!validKey(req.params.key))return res.sendStatus(404);
        try {
            const entry=await access(supabase,req.params.id,req.user.id);
            if(!entry || entry.status!=="accepted")return res.sendStatus(404);
            const {data,error}=await supabase.from("one_off_plan_comments").select("user_id").eq("plan_id",entry.plan.id).contains("photo_ids",[req.params.key]).limit(1);
            if(error)throw error;
            if(!data?.length)return res.sendStatus(404);
            const author=data[0].user_id;
            if(author!==req.user.id){
                if(entry.plan.kind!=="shared")return res.sendStatus(404);
                const authorAccess=await access(supabase,entry.plan.id,author);
                if(authorAccess?.status!=="accepted" || (await relationship(supabase,req.user.id,author)).blocked)return res.sendStatus(404);
            }
            const file=await supabase.storage.from("activity-images").download(commentPhotoPath(entry.plan.id,req.params.key));
            if(file.error)throw file.error;
            return res.set({"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}).type("image/jpeg").send(Buffer.from(await file.data.arrayBuffer()));
        }catch(error){return failed(res,error);}
    });
    app.post("/plans/:id/comment-photos",auth,async(req,res,next)=>{
        if(!signedIn(req,res))return;
        try {
            const entry=await access(supabase,req.params.id,req.user.id);
            if(!entry || entry.status!=="accepted" || entry.plan.status==="canceled")return res.sendStatus(403);
            if (!await linkedGroupPermission(supabase, entry.plan.chat_id, req.user.id, "plan_comment")) return res.status(403).json({ success:false });
            req.planCommentEntry=entry;next();
        }catch(error){return failed(res,error);}
    },commentUpload.array("photos",4),async(req,res)=>{
        const expected=keys(req.body.expected),keep=keys(req.body.keep),text=req.body.text,files=req.files || [];
        if(!expected || !keep || !keep.every(k=>expected.includes(k)) || keep.length+files.length>4 || typeof text!=="string" || text.length>200 || !files.every(f=>validPhoto(f,1600)))return res.sendStatus(400);
        try {
            const id=req.planCommentEntry.plan.id,added=[];
            for(const file of files){
                const key=randomUUID(),path=commentPhotoPath(id,key);
                const reserve=await supabase.from("activity_image_cleanup").insert({path,due_at:new Date(Date.now()+86400000).toISOString()});
                if(reserve.error)throw reserve.error;
                const result=await supabase.storage.from("activity-images").upload(path,file.buffer,{contentType:"image/jpeg",upsert:false});
                if(result.error)throw result.error;
                added.push(key);
            }
            const current=await access(supabase,id,req.user.id);
            if(current?.status!=="accepted" || current.plan.status==="canceled")return res.sendStatus(403);
            if (!await linkedGroupPermission(supabase, current.plan.chat_id, req.user.id, "plan_comment")) return res.status(403).json({ success:false });
            const {error}=await supabase.rpc("save_plan_comment_images",{p_actor:req.user.id,p_plan:Number(id),p_text:text,p_expected:expected,p_keep:keep,p_new:added});
            if(error)throw error;
            return res.json({success:true,photos:[...keep,...added]});
        }catch(error){
            if(error.code==="40001")return res.sendStatus(409);
            if(error.code==="42501")return res.sendStatus(403);
            if(error.code==="22023")return res.sendStatus(400);
            return failed(res,error);
        }
    });

    app.post("/plans/:id/comment",auth,async(req,res) => {
        if (!signedIn(req,res)) return;
        const comment = req.body?.comment;
        if (typeof comment !== "string" || comment.length > 200) {
            return res.status(400).json({ success:false,error:"Комментарий должен быть не длиннее 200 символов" });
        }
        try {
            const entry = await access(supabase,req.params.id,req.user.id);
            if (!entry) return res.status(404).json({ success:false });
            if (entry.status !== "accepted" || entry.plan.status === "canceled")
                return res.status(403).json({ success:false });
            if (!await linkedGroupPermission(supabase, entry.plan.chat_id, req.user.id, "plan_comment")) return res.status(403).json({ success:false });
            if (!comment.trim()) {
                const { error } = await supabase.from("one_off_plan_comments")
                    .delete().eq("plan_id",entry.plan.id).eq("user_id",req.user.id);
                if (error) throw error;
            } else {
                const { error } = await supabase.from("one_off_plan_comments").upsert({
                    plan_id:entry.plan.id, user_id:req.user.id,comment,
                    updated_at:new Date().toISOString()
                },{ onConflict:"plan_id,user_id" });
                if (error) throw error;
            }
            return res.json({ success:true,comment:comment.trim() ? comment : "" });
        } catch(error) { return failed(res,error); }
    });

    app.delete("/plans/:id",auth,async(req,res) => {
        if (!signedIn(req,res)) return;
        try {
            const entry = await access(supabase,req.params.id,req.user.id);
            if (!entry) return res.status(404).json({ success:false });
            if (!entry.owner) return res.status(403).json({ success:false });
            const { error } = await supabase.from("one_off_plans").delete()
                .eq("id",entry.plan.id).eq("owner_id",req.user.id);
            if (error) throw error;
            return res.json({ success:true });
        } catch(error) { return failed(res,error); }
    });
}
