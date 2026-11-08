import { sendWebPush, validPushEndpoint } from "../utils/webPush.js";

let running = false;

async function completeJob(supabase, job, state, errorCode = null) {
    const { error } = await supabase.from("at_habit_reminder_jobs").update({
        state,
        error_code: errorCode,
        completed_at: state === "pending" ? null : new Date().toISOString()
    }).eq("id", job.id).eq("state", "processing");
    if (error) console.error("[reminders] job update failed:", error.message);
}

async function deliverJob(supabase, job) {
    try {
        const [{ data: user, error: userError },
            { data: settings, error: settingsError },
            { data: preferences, error: preferencesError },
            { data: habit, error: habitError }] = await Promise.all([
            supabase.from("users").select("id,deletion_requested_at").eq("id", job.user_id).maybeSingle(),
            supabase.from("settings").select("all_note").eq("user_id", job.user_id).maybeSingle(),
            supabase.from("at_habit_reminder_preferences").select("enabled").eq("user_id", job.user_id).maybeSingle(),
            supabase.from("habits").select("id,name,ongoing").eq("id", job.habit_id).maybeSingle()
        ]);
        if (userError || settingsError || preferencesError || habitError) {
            throw userError || settingsError || preferencesError || habitError;
        }
        if (!user || user.deletion_requested_at || settings?.all_note === false ||
            !preferences?.enabled || !habit?.ongoing) {
            return await completeJob(supabase, job, "skipped", "disabled");
        }
        const { data: subscriptions, error: lookupError } = await supabase
            .from("at_push_subscriptions")
            .select("endpoint,endpoint_hash,p256dh,auth,expiration_time,session_id")
            .eq("user_id", job.user_id).limit(10);
        if (lookupError) throw lookupError;
        if (!subscriptions?.length) return await completeJob(supabase, job, "skipped", "not_subscribed");
        const sessionIds = [...new Set(subscriptions.map(s => s.session_id).filter(Boolean))];
        const { data: activeSessions, error: sessionError } = await supabase.from("at_user_sessions")
            .select("id").in("id", sessionIds.length ? sessionIds : ["00000000-0000-0000-0000-000000000000"])
            .is("revoked_at", null).gt("expires_at", new Date().toISOString());
        if (sessionError) throw sessionError;
        const active = new Set((activeSessions || []).map(value => value.id));
        const validSubscriptions = subscriptions.filter(subscription =>
            active.has(subscription.session_id) && validPushEndpoint(subscription.endpoint));
        if (!validSubscriptions.length) {
            return await completeJob(supabase, job, "skipped", "no_active_subscriptions");
        }

        const payload = {
            title: "AchieveTogether",
            body: "Напоминание об активности / Activity reminder: " + String(habit.name).slice(0, 90),
            url: "/habit/" + encodeURIComponent(String(habit.id)),
            tag: "at-reminder-" + job.habit_id + "-" + job.reminder_code
        };
        const attempts = await Promise.allSettled(validSubscriptions.map(async subscription => {
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
            await completeJob(supabase, job, "sent");
        } else if (job.attempts < 3) {
            await completeJob(supabase, job, "pending", "delivery_failed");
        } else {
            await completeJob(supabase, job, "failed", "delivery_failed");
        }
    } catch (error) {
        console.error("[reminders] delivery error:", error.message);
        await completeJob(supabase, job, job.attempts < 3 ? "pending" : "failed", "server_error");
    }
}

export async function dispatchDueHabitReminders(supabase) {
    if (running) return;
    running = true;
    try {
        const { data: jobs, error } = await supabase.rpc("at_claim_due_habit_reminder_jobs", { p_limit: 50 });
        if (error) throw error;
        for (let index = 0; index < (jobs || []).length; index += 10) {
            await Promise.allSettled(jobs.slice(index, index + 10).map(job => deliverJob(supabase, job)));
        }
    } catch (error) {
        console.error("[reminders] poll error:", error.message);
    } finally {
        running = false;
    }
}

export function startHabitReminderWorker(supabase) {
    const firstRun = setTimeout(() => { void dispatchDueHabitReminders(supabase); }, 3000);
    const interval = setInterval(() => { void dispatchDueHabitReminders(supabase); }, 30000);
    firstRun.unref?.();
    interval.unref?.();
}
