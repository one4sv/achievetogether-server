import express from "express";
import cors from "cors";
import registerRoutes from "./register.js";
import authRoutes from "./auth.js";
import confirmRoutes from "./confirm.js";
import userRoutes from "./user.js";
import logoutRoutes from "./logout.js";
import addhabitRoutes from "./addhabit.js";
import habitsRoutes from "./habits.js";
import settingsRoutes from "./settings.js";
import updatesettingsRoutes from "./updatesettings.js";
import updatehabitRoutes from "./updatehabit.js";
import contactsRoutes from "./contacts.js";
import chatRoutes from "./chat.js";
import adminRoutes from "./admin.js";
import accRoutes from "./acc.js";
import deleteRoutes from "./delete.js";
import updateuserRoutes from "./updateuser.js"
import uploadavatarRoutes from "./uploadavatar.js"
import uploadbgRoutes from "./uploadbg.js"
import markdoneRoutes from "./markdone.js"
import calendarRoutes from "./calendar.js"
import daycommentRoutes from "./daycomment.js"
import pingRoutes from "./ping.js"
import reactionsRoutes from "./reaction.js"
import askauthRoutes from "./askauth.js"
import addpostRoutes from "./addpost.js"
import postsRoutes from "./posts.js"
import uppostRoutes from "./uppost.js"

import { createClient } from "@supabase/supabase-js";
import initWebSocket from "./ws.js";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import dotenv from "dotenv";
dotenv.config();
process.stdout.setDefaultEncoding('utf8');
process.stderr.setDefaultEncoding('utf8');

const app = express();

app.use(cors({
  origin: process.env.CLIENT_URL || 'https://achievetogether.vercel.app',
  credentials: true
}));

app.use(express.json());
app.use(cookieParser());

app.get('/', (req, res) => {
  res.send('Backend AT server is running');
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

registerRoutes(app, supabase);
authRoutes(app, supabase);
confirmRoutes(app, supabase);
userRoutes(app, supabase);
addhabitRoutes(app, supabase);
habitsRoutes(app, supabase);
settingsRoutes(app, supabase);
updatesettingsRoutes(app, supabase);
updatehabitRoutes(app, supabase);
contactsRoutes(app, supabase);
chatRoutes(app, supabase);
adminRoutes(app, supabase);
accRoutes(app, supabase);
deleteRoutes(app, supabase);
updateuserRoutes(app, supabase);
uploadavatarRoutes(app, supabase);
uploadbgRoutes(app, supabase);
markdoneRoutes(app, supabase);
calendarRoutes(app, supabase);
daycommentRoutes(app, supabase);
pingRoutes(app, supabase);
reactionsRoutes(app, supabase);
askauthRoutes(app, supabase);
addpostRoutes(app, supabase);
postsRoutes(app, supabase);
uppostRoutes(app, supabase);
logoutRoutes(app);

const server = createServer(app);

initWebSocket(supabase, server);

// Запуск сервера
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
