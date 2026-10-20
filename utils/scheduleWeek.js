export const isEvenScheduleWeek = (weekStart, date) => {
    const monday = value => {
        const day = new Date(`${value}T00:00:00Z`);
        const weekday = day.getUTCDay();
        day.setUTCDate(day.getUTCDate() + (weekday === 0 ? -6 : 1 - weekday));
        return day.getTime();
    };
    const weekNumber = Math.round((monday(date) - monday(weekStart || "2025-09-01")) / 604800000);
    return weekNumber % 2 !== 0;
};
