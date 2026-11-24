const modes = new Set(["manual", "metric", "milestones", "combined", "days", "streak", "daily_timer", "daily_counter", "total_timer"]);
const statuses = new Set(["active", "paused", "completed", "canceled", "archived"]);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const validNumber = value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1000000000;
const clamp = value => Math.max(0, Math.min(100, value));

export function validGoalDate(value) {
    if (value === null) return true;
    if (typeof value !== "string" || !datePattern.test(value)) return false;
    const parsed = new Date(value + "T12:00:00Z");
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateGoal(body, old = null) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const keys = ["name", "description", "due_date", "progress_mode", "status",
        "manual_progress", "metric_start", "metric_target", "metric_current", "metric_unit", "metric_share", "target_days", "daily_minutes", "auto_complete", "reminder_days", "repeat_frequency"];
    if (!Object.keys(body).length || Object.keys(body).some(key => !keys.includes(key))) return null;
    const v = { ...body };
    if ("name" in v) {
        if (typeof v.name !== "string" || !v.name.trim() || v.name.length > 160) return null;
        v.name = v.name.trim();
    }
    if (!old && !v.name) return null;
    if ("description" in v && (typeof v.description !== "string" || v.description.length > 1200)) return null;
    if ("due_date" in v && !validGoalDate(v.due_date)) return null;
    if ("status" in v && !statuses.has(v.status)) return null;
    if ("progress_mode" in v && !modes.has(v.progress_mode)) return null;
    if ("metric_unit" in v && (typeof v.metric_unit !== "string" || v.metric_unit.length > 24)) return null;
    for (const key of ["manual_progress", "metric_start", "metric_target", "metric_current", "metric_share"]) {
        if (key in v && !validNumber(v[key])) return null;
    }
    if ("manual_progress" in v && (v.manual_progress < 0 || v.manual_progress > 100)) return null;
    if ("metric_share" in v && (v.metric_share < 0 || v.metric_share > 1)) return null;
    if ("target_days" in v && (!Number.isInteger(v.target_days) || v.target_days < 1 || v.target_days > 3650)) return null;
    if ("daily_minutes" in v && (!Number.isInteger(v.daily_minutes) || v.daily_minutes < 1 || v.daily_minutes > 1440)) return null;
    if ("repeat_frequency" in v && !["none","daily","weekly","monthly"].includes(v.repeat_frequency)) return null;
    if ("auto_complete" in v && typeof v.auto_complete !== "boolean") return null;
    if ("reminder_days" in v && v.reminder_days !== null && (!Number.isInteger(v.reminder_days) || v.reminder_days<0 || v.reminder_days>30)) return null;
    const merged = { progress_mode:"manual",metric_start:0,metric_target:100,metric_current:0,
        ...old,...v };
    if (merged.progress_mode === "daily_counter" && (!Number.isInteger(Number(merged.metric_target)) || Number(merged.metric_target) < 1 || Number(merged.metric_target) > 1000000000)) return null;
    if (merged.progress_mode === "total_timer" && (!Number.isInteger(Number(merged.metric_target)) || Number(merged.metric_target) < 1 || Number(merged.metric_target) > 1000000000)) return null;
    if (["metric","combined"].includes(merged.progress_mode) && merged.metric_target === merged.metric_start) return null;
    return v;
}
export function validateGoalStage(body, creating = true) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const keys = ["title", "weight", "completion_percent", "completed"];
    if (!Object.keys(body).length || Object.keys(body).some(k => !keys.includes(k))) return null;
    const v = { ...body };
    if (creating && !("title" in v)) return null;
    if ("title" in v && (typeof v.title !== "string" || !v.title.trim() || v.title.length > 160)) return null;
    if ("title" in v) v.title = v.title.trim();
    if ("weight" in v && (!validNumber(v.weight) || v.weight < 0.001 || v.weight > 10000)) return null;
    if ("completion_percent" in v && (!validNumber(v.completion_percent) || v.completion_percent < 0 || v.completion_percent > 100)) return null;
    if ("completed" in v && typeof v.completed !== "boolean") return null;
    if (creating && "completed" in v) return null;
    return v;
}
export function goalProgress(goal, stages = []) {
    const manual = clamp(Number(goal.manual_progress ?? 0));
    const start = Number(goal.metric_start ?? 0), target = Number(goal.metric_target ?? 100);
    const current = Number(goal.metric_current ?? start);
    const metric = target === start ? 0 : clamp((current - start) / (target - start) * 100);
    const total = stages.reduce((sum,s) => sum + Number(s.weight ?? 1),0);
    const done = stages.reduce((sum,s) => sum + (s.completed_at ? Number(s.weight ?? 1) : 0),0);
    let milestones = total > 0 ? clamp(done / total * 100) : 0;
    if(stages.some(s=>s.completion_percent!=null)) {
        // Explicit milestones mark the percentage achieved upon completion; legacy weights remain readable.
        let cumulative=0;
        milestones=0;
        for(const stage of [...stages].sort((a,b)=>Number(a.position ?? 0)-Number(b.position ?? 0) || Number(a.id ?? 0)-Number(b.id ?? 0))) {
            cumulative+=Number(stage.weight ?? 1);
            const percent=stage.completion_percent==null ? (total>0?cumulative/total*100:0) : Number(stage.completion_percent);
            if(stage.completed_at) milestones=Math.max(milestones,percent);
        }
        milestones=clamp(milestones);
    }
    const mode = goal.progress_mode || "manual";
    const amount = mode === "metric" ? metric : mode === "milestones" ? milestones :
        mode === "combined" ? metric * Number(goal.metric_share ?? 0.5) +
            milestones * (1 - Number(goal.metric_share ?? 0.5)) : manual;
    return Math.round(clamp(amount) * 100) / 100;
}
