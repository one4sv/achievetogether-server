const ALLOWED_BUCKETS = new Set(["posts", "media", "avatars", "bgs"]);
let running = false;

async function cleanupBatch(supabase) {
    if (running) return;
    running = true;
    try {
        const { data: jobs, error } = await supabase.from("at_storage_cleanup_jobs")
            .select("id,bucket_id,object_path,attempts")
            .eq("state", "pending").order("created_at").limit(100);
        if (error) throw error;
        const grouped = new Map();
        for (const job of jobs || []) {
            if (!ALLOWED_BUCKETS.has(job.bucket_id) || !job.object_path || job.object_path.length > 800) {
                await supabase.from("at_storage_cleanup_jobs").update({ state: "failed" }).eq("id", job.id);
                continue;
            }
            if (!grouped.has(job.bucket_id)) grouped.set(job.bucket_id, []);
            grouped.get(job.bucket_id).push(job);
        }
        for (const [bucket, selected] of grouped) {
            try {
                const { error: removalError } = await supabase.storage.from(bucket)
                    .remove(selected.map(job => job.object_path));
                if (removalError) throw removalError;
                const { error: updateError } = await supabase.from("at_storage_cleanup_jobs")
                    .update({ state: "done", completed_at: new Date().toISOString() })
                    .in("id", selected.map(job => job.id)).eq("state", "pending");
                if (updateError) throw updateError;
            } catch (removalError) {
                console.warn("[account-storage-cleanup] batch failed:", removalError.message);
                await Promise.allSettled(selected.map(job => supabase.from("at_storage_cleanup_jobs")
                    .update({ attempts: job.attempts + 1, state: job.attempts >= 4 ? "failed" : "pending" })
                    .eq("id", job.id).eq("state", "pending")));
            }
        }
    } catch (error) {
        console.error("[account-storage-cleanup]", error.message);
    } finally {
        running = false;
    }
}

export function startAccountStorageCleanup(supabase) {
    const first = setTimeout(() => { void cleanupBatch(supabase); }, 60000);
    const interval = setInterval(() => { void cleanupBatch(supabase); }, 5 * 60000);
    first.unref?.();
    interval.unref?.();
}
