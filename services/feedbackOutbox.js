import { sendMail } from "./sendmail.js";

let running = false;

export async function dispatchFeedbackOutbox(supabase, deliver = sendMail) {
    if (running) return;
    running = true;
    try {
        const { data: jobs, error } = await supabase.rpc("at_claim_feedback_outbox", { p_limit: 10 });
        if (error) throw error;
        for (const job of jobs || []) {
            try {
                await deliver(job.recipient, job.subject, job.html);
                const { error: updateError } = await supabase.from("at_feedback_outbox")
                    .update({ status: "sent", delivered_at: new Date().toISOString(), last_error_code: null })
                    .eq("id", job.id).eq("status", "processing");
                if (updateError) throw updateError;
            } catch {
                const failed = job.attempts >= 5;
                const delay = Math.min(60, 2 ** Math.max(0, job.attempts - 1));
                const { error: retryError } = await supabase.from("at_feedback_outbox").update({
                    status: failed ? "failed" : "pending",
                    next_attempt_at: new Date(Date.now() + delay * 60000).toISOString(),
                    claimed_at: null,
                    last_error_code: "delivery_failed"
                }).eq("id", job.id).eq("status", "processing");
                if (retryError) console.error("[feedback] queue update failed");
            }
        }
    } catch {
        console.error("[feedback] queue polling failed");
    } finally {
        running = false;
    }
}

export function startFeedbackOutboxWorker(supabase) {
    const firstRun = setTimeout(() => { void dispatchFeedbackOutbox(supabase); }, 15000);
    const interval = setInterval(() => { void dispatchFeedbackOutbox(supabase); }, 60000);
    firstRun.unref?.();
    interval.unref?.();
}
