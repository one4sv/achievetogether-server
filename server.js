import "./config/env.js";
import { createClient } from "@supabase/supabase-js";
import { createServer } from "node:http";
import createApp from "./app.js";
import initWebSocket from "./realtime/ws.js";

process.stdout.setDefaultEncoding("utf8");
process.stderr.setDefaultEncoding("utf8");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY || !process.env.JWT_SECRET) {
    throw new Error("Set SUPABASE_URL, SUPABASE_KEY and JWT_SECRET in server/.env");
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const app = createApp(supabase);
const server = createServer(app);
initWebSocket(supabase, server);

const port = process.env.PORT || 3001;
server.listen(port, () => console.log(`AT server running on port ${port}`));
