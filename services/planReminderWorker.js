import { sendWebPush, validPushEndpoint } from "../utils/webPush.js";

let running = false;

async function finish(supabase, job, state, errorCode = null) {
    const { error } = await supabase.from("at_plan_reminder_jobs").update({
        state, error_code: errorCode,
        completed_at: state === "pending" ? null : new Date().toISOString()
    }).eq("id", job.id).eq("state", "processing");
    if (error) console.error("[plan-reminders] job update failed:", error.message);
}

async function deliver(supabase, job) {
    try {
        const [userResult, settingsResult, preferencesResult, planResult] = await Promise.all([
            supabase.from("users").select("id,deletion_requested_at").eq("id", job.user_id).maybeSingle(),
            supabase.from("settings").select("all_note").eq("user_id", job.user_id).maybeSingle(),
            supabase.from("at_plan_reminder_preferences")
                .select("enabled,default_minutes_before").eq("user_id", job.user_id).maybeSingle(),
            supabase.from("one_off_plans")
                .select("id,name,owner_id,status,updated_at").eq("id", job.plan_id).maybeSingle()
        ]);
        const errors = [userResult,settingsResult,preferencesResult,planResult].map(result => result.error).find(Boolean);
        if (errors) throw errors;
        const user = userResult.data;
        const plan = planResult.data;
        const prefs = preferencesResult.data;
        if (!user || user.deletion_requested_at || settingsResult.data?.all_note === false ||
            !prefs?.enabled || !plan || plan.status !== "upcoming" ||
            (plan.updated_at && new Date(plan.updated_at) > new Date(job.created_at))) {
            return await finish(supabase, job, "skipped", "inactive");
        }
        if (plan.owner_id !== job.user_id) {
            const { data: membership, error } = await supabase.from("one_off_plan_members")
                .select("status").eq("plan_id", job.plan_id).eq("user_id", job.user_id).maybeSingle();
            if (error) throw error;
            if (membership?.status !== "accepted") return await finish(supabase, job, "skipped", "left_plan");
        }
        if (job.rule_code === "default" && prefs.default_minutes_before !== job.minutes_before) {
            return await finish(supabase, job, "skipped", "changed");
        }
        if (job.rule_code !== "default") {
            const { data: rule, error } = await supabase.from("at_plan_reminder_rules")
                .select("minutes_before").eq("user_id", job.user_id)
                .eq("plan_id", job.plan_id).eq("minutes_before", job.minutes_before).maybeSingle();
            if (error) throw error;
            if (!rule) return await finish(supabase, job, "skipped", "removed");
        }
        const { data: subscriptions, error: lookupError } = await supabase
            .from("at_push_subscriptions")
            .select("endpoint,endpoint_hash,p256dh,auth,expiration_time,session_id")
            .eq("user_id", job.user_id).limit(10);
        if (lookupError) throw lookupError;
        if (!subscriptions?.length) return await finish(supabase, job, "skipped", "not_subscribed");
        const sessionIds = [...new Set(subscriptions.map(s => s.session_id).filter(Boolean))];
        const { data: activeSessions, error: sessionError } = await supabase.from("at_user_sessions")
            .select("id").in("id", sessionIds.length ? sessionIds : ["00000000-0000-0000-0000-000000000000"])
            .is("revoked_at", null).gt("expires_at", new Date().toISOString());
        if (sessionError) throw sessionError;
        const active = new Set((activeSessions || []).map(s => s.id));
        const targets = subscriptions.filter(s => active.has(s.session_id) && validPushEndpoint(s.endpoint));
        if (!targets.length) return await finish(supabase, job, "skipped", "no_active_subscriptions");
        const payload = {
            title: "AchieveTogether",
            body: "Напоминание о плане / Plan reminder: " + String(plan.name).slice(0, 90),
            url: "/plan/" + encodeURIComponent(String(plan.id)),
            tag: "at-plan-reminder-" + job.plan_id + "-" + job.rule_code
        };
        const attempts = await Promise.allSettled(targets.map(async subscription => {
            const result = await sendWebPush({
                endpoint: subscription.endpoint,
                expirationTime: subscription.expiration_time,
                keys: { p256dh: subscription.p256dh, auth: subscription.auth }
            }, payload);
            if (result.status === 404 || result.status === 410) {
                await supabase.from("at_push_subscriptions").delete()
                    .eq("user_id", job.user_id).eq("endpoint_hash", subscription.endpoint_hash);
            }
            return result.delivered;
        }));
        if (attempts.some(item => item.status === "fulfilled" && item.value === true)) {
            await finish(supabase, job, "sent");
        } else {
            await finish(supabase, job, job.attempts < 3 ? "pending" : "failed", "delivery_failed");
        }
    } catch (error) {
        console.error("[plan-reminders] delivery error:", error.message);
        await finish(supabase, job, job.attempts < 3 ? "pending" : "failed", "server_error");
    }
}

export async function dispatchDuePlanReminders(supabase) {
    if (running) return;
    running = true;
    try {
        const { data: jobs, error } = await supabase.rpc("at_claim_due_plan_reminder_jobs", { p_limit: 50 });
        if (error) throw error;
        for (let index = 0; index < (jobs || []).length; index += 10) {
            await Promise.allSettled(jobs.slice(index, index + 10).map(job => deliver(supabase, job)));
        }
    } catch (error) {
        console.error("[plan-reminders] poll error:", error.message);
    } finally {
        running = false;
    }
}

export function startPlanReminderWorker(supabase) {
    const initial = setTimeout(() => { void dispatchDuePlanReminders(supabase); }, 4000);
    const interval = setInterval(() => { void dispatchDuePlanReminders(supabase); }, 30000);
    initial.unref?.();
    interval.unref?.();
}
