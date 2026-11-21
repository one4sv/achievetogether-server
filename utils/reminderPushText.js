// The preferred push language belongs to the browser subscription, not the
// shared AT account. Old subscriptions fall back to Russian until re-synced.
export const normalizeReminderLanguage = language => language === "en" ? "en" : "ru";

export function habitReminderBody(common, habitName, language) {
    const english = normalizeReminderLanguage(language) === "en";
    if (common) return english ? "Time for today's activities" : "Время отметить активности на сегодня";
    return (english ? "Activity reminder: " : "Напоминание об активности: ") + String(habitName || "").slice(0, 90);
}

export function planReminderBody(planName, language) {
    const english = normalizeReminderLanguage(language) === "en";
    return (english ? "Plan reminder: " : "Напоминание о плане: ") + String(planName || "").slice(0, 90);
}
