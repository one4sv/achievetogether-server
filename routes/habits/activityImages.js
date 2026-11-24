import multer from "multer";
import { randomUUID } from "node:crypto";
import { authenticateUser } from "../../middleware/token.js";
import { requireHabitPermission, requireHabitView } from "../../utils/habitAccess.js";
import { canCompleteHabitDay } from "../../utils/habitCompletionDate.js";
import { isCalendarDate } from "../../utils/validation.js";
import { keys, validKey, validPhoto } from "../../utils/activityImages.js";
import { broadcastHabitCommentUpdated } from "../../realtime/ws.js";

const bucket="activity-images";
const objectPath=(id,key)=>id+"/"+key+".jpg";
const upload=multer({storage:multer.memoryStorage(),limits:{files:4,fileSize:800000,fields:4,fieldSize:2048,parts:9}});

export default function activityImages(app,db) {
    const auth=authenticateUser(db);
    async function store(id,file) {
        const key=randomUUID(),path=objectPath(id,key);
        const {error:reserve}=await db.from("activity_image_cleanup").insert({path,due_at:new Date(Date.now()+86400000).toISOString()});
        if(reserve) throw reserve;
        const {error}=await db.storage.from(bucket).upload(path,file.buffer,{contentType:"image/jpeg",upsert:false});
        if(error) throw error;
        return key;
    }
    // Both failed uploads and objects detached by cascading deletes are retried.
    let cleaning=false;
    const cleanup=async()=>{
        if(cleaning) return;
        cleaning=true;
        try {
            const {data,error}=await db.from("activity_image_cleanup").select("path").lte("due_at",new Date().toISOString()).order("due_at").limit(50);
            if(error) throw error;
            const paths=data.map(row=>row.path);
            if(!paths.length) return;
            const removed=await db.storage.from(bucket).remove(paths);
            if(removed.error) throw removed.error;
            const done=await db.from("activity_image_cleanup").delete().in("path",paths);
            if(done.error) throw done.error;
        } catch(error){console.error("Activity image cleanup",error.message);}
        finally{cleaning=false;}
    };
    setInterval(cleanup,600000).unref();

    const allowedDay=(access,date)=>isCalendarDate(date) && (access.is_owner || access.is_member) && canCompleteHabitDay(access,date);
    const failed=(res,error)=>{
        const status=error.code==="40001"?409:error.code==="42501"?403:error.code==="22023"?400:500;
        if(status===500) console.error("Activity image",error.message);
        return res.status(status).json({success:false});
    };
    async function image(res,id,key) {
        const {data,error}=await db.storage.from(bucket).download(objectPath(id,key));
        if(error) throw error;
        res.set({"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}).type("image/jpeg").send(Buffer.from(await data.arrayBuffer()));
    }
    app.get("/habits/:id/avatar/:key",auth,requireHabitView(db),async(req,res)=>{
        const {id,key}=req.params;
        if(!validKey(key) || req.habitAccess.habit.avatar_key!==key) return res.sendStatus(404);
        try {await image(res,req.habitAccess.habit.id,key);} catch(error){failed(res,error);}
    });
    app.put("/habits/:id/avatar",auth,requireHabitPermission(db,"edit_info"),upload.single("avatar"),async(req,res)=>{
        const {habit}=req.habitAccess;
        if(!habit.ongoing) return res.sendStatus(403);
        if(req.file ? !validPhoto(req.file,512) : req.body?.remove!=="true") return res.sendStatus(400);
        try {
            const key=req.file ? await store(habit.id,req.file) : null;
            let query=db.from("habits").update({avatar_key:key}).eq("id",habit.id).eq("ongoing",true);
            query=habit.avatar_key ? query.eq("avatar_key",habit.avatar_key) : query.is("avatar_key",null);
            const {data,error}=await query.select("id").maybeSingle();
            if(error) throw error;
            if(!data) return res.sendStatus(409);
            res.json({success:true,avatar_key:key});
        } catch(error){failed(res,error);}
    });
    app.get("/habits/:id/comment-photos/:date",auth,requireHabitPermission(db,"view"),async(req,res)=>{
        if(!allowedDay(req.habitAccess,req.params.date))return res.sendStatus(403);
        try{
            const {data,error}=await db.from("completions_comments").select("photo_ids,comment").eq("habit_id",req.params.id)
                .eq("date",req.params.date).eq("user_id",req.user.id).maybeSingle();
            if(error) throw error;
            res.set("Cache-Control","private, no-store").json({success:true,photos:data?.photo_ids || [],text:data?.comment || ""});
        }catch(error){failed(res,error);}
    });
    app.get("/habits/:id/comment-photos/:date/:key",auth,requireHabitPermission(db,"view"),async(req,res)=>{
        const {id,key,date}=req.params;
        if(!allowedDay(req.habitAccess,date) || !validKey(key)) return res.sendStatus(403);
        try {
            const {data,error}=await db.from("completions_comments").select("id").eq("habit_id",id).eq("date",date).contains("photo_ids",[key]).limit(1);
            if(error) throw error;
            if(!data.length) return res.sendStatus(404);
            await image(res,req.habitAccess.habit.id,key);
        } catch(error){failed(res,error);}
    });
    app.post("/habits/:id/comment-photos/:date",auth,requireHabitPermission(db,"comment"),upload.array("photos",4),async(req,res)=>{
        const {id,date}=req.params;
        if(!req.habitAccess.habit.ongoing || !allowedDay(req.habitAccess,date)) return res.sendStatus(403);
        const expected=keys(req.body.expected), keep=keys(req.body.keep), text=req.body.text, files=req.files || [];
        if(!expected || !keep || !keep.every(key=>expected.includes(key)) || keep.length+files.length>4 ||
            typeof text!=="string" || text.length>200 || !files.every(f=>validPhoto(f,1600))) return res.sendStatus(400);
        try{
            const added=[];
            for(const file of files) added.push(await store(req.habitAccess.habit.id,file));
            const {error}=await db.rpc("save_activity_comment_images",{p_actor:req.user.id,p_habit:Number(id),p_date:date,p_text:text,
                p_expected:expected,p_keep:keep,p_new:added});
            if(error) throw error;
            void broadcastHabitCommentUpdated(db,Number(id),date);
            res.json({success:true,photos:[...keep,...added]});
        }catch(error){failed(res,error);}
    });
}

