export const isPositiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;

export const isCalendarDate = value => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export const normalizeTime = value => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string") return undefined;
    const match = /^(\d{1,2})(?:[:.](\d{1,2}))?$/.exec(value.trim());
    if (!match || Number(match[1]) > 23 || Number(match[2] || 0) > 59) return undefined;
    return `${match[1].padStart(2, "0")}:${(match[2] || "0").padStart(2, "0")}`;
};

export const checklistInput = body => {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 1000 || !isCalendarDate(body.date)) return null;
    const start = normalizeTime(body.start_time);
    const end = normalizeTime(body.end_time);
    if (start === undefined || end === undefined) return null;
    return { name: body.name.trim(), start_time: start, end_time: end, date: body.date };
};
