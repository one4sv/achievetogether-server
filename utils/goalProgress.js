const MODES = new Set(["manual", "metric", "milestones", "combined"]);
const STATUSES = new Set(["draft", "active", "paused", "completed", "canceled", "archived"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validGoalDate(value) {
    if (value === null) return true;
    if (typeof value !== "string" || !DATE.test(value)) return false;
    const date = new Date(value + "T12:00:00Z");
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const numeric = (value) => typeof value === "number" && Number.isFinite(value) &&
    Math.abs(value) <= 1000000000000;
const clamp = value => Math.max(0, Math.min(100, value));

export function normalizeGoalInput(input, previous = null) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const keys = ["name", "description", "due_date", "progress_mode", "status",
        "manual_progress", "metric_start", "metric_target", "metric_current", "metric_unit", "metric_share"];
    if (Object.keys(input).some(key => !keys.includes(key)) || !Object.keys(input).length) return null;
    const result = { ...input };
    if ("name" in result) {
        if (typeof result.name !== "string" || !result.name.trim() || result.name.length > 160) return null;
        result.name = result.name.trim();
    }
    if (!previous && !result.name) return null;
    if ("description" in result && (typeof result.description !== "string" || result.description.length > 1200)) return null;
    if ("due_date" in result && !validGoalDate(result.due_date)) return null;
    if ("progress_mode" in result && !MODES.has(result.progress_mode)) return null;
    if ("status" in result && !STATUSES.has(result.status)) return null;
    for (const key of ["manual_progress", "metric_start", "metric_target", "metric_current", "metric_share"]) {
        if (key in result && !numeric(result[key])) return null;
    }
    if ("manual_progress" in result && (result.manual_progress < 0 || result.manual_progress > 100)) return null;
    if ("metric_share" in result && (result.metric_share < 0 || result.metric_share > 1)) return null;
    if ("metric_unit" in result && (typeof result.metric_unit !== "string" || result.metric_unit.length > 24)) return null;
    const merged = { progress_mode:"manual", metric_start:0, metric_target:100,
        metric_current:0, metric_share:0.7, ...previous, ...result };
    if (["metric", "combined"].includes(merged.progress_mode) &&
        merged.metric_target === merged.metric_start) return null;
    return result;
}

export function normalizeMilestone(input, partial = false) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const keys = ["title", "weight", "completed"];
    if (Object.keys(input).some(key => !keys.includes(key)) || !Object.keys(input).length) return null;
    if (!partial && typeof input.title !== "string") return null;
    const result = { ...input };
    if ("title" in result) {
        if (typeof result.title !== "string" || !result.title.trim() || result.title.length > 160) return null;
        result.title = result.title.trim();
    }
    if ("weight" in result && (!numeric(result.weight) || result.weight <= 0 || result.weight > 10000)) return null;
    if ("completed" in result && typeof result.completed !== "boolean") return null;
    return result;
}

export function goalProgress(goal, milestones = []) {
    const mode = goal.progress_mode || "manual";
    const manual = clamp(Number(goal.manual_progress) || 0);
    const start = Number(goal.metric_start);
    const target = Number(goal.metric_target);
    const current = Number(goal.metric_current);
    const metric = target === start ? 0 : clamp((current - start) / (target - start) * 100);
    const total = milestones.reduce((sum, stage) => sum + Number(stage.weight || 1), 0);
    const done = milestones.reduce((sum, stage) => sum + (stage.completed_at ? Number(stage.weight || 1) : 0), 0);
    const stageProgress = total ? clamp(done / total * 100) : 0;
    if (mode === "metric") return Math.round(metric * 100) / 100;
    if (mode === "milestones") return Math.round(stageProgress * 100) / 100;
    if (mode === "combined") {
        const share = Number(goal.metric_share ?? 0.7);
        return Math.round((share * metric + (1 - share) * stageProgress) * 100) / 100;
    }
    return Math.round(manual * 100) / 100;
}
