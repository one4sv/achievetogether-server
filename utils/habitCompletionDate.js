// Completion days are stored in the Moscow calendar, not the server's UTC day.
export function moscowDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Moscow",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(date);
}

export function canCompleteHabitDay(access, date) {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    if (!access?.habit?.chat_id || access.is_owner) return true;
    return !!access.completion_start_date && date >= access.completion_start_date;
}
