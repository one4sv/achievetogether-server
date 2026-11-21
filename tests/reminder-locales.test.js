import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReminderLanguage, habitReminderBody, planReminderBody } from "../utils/reminderPushText.js";

test("each reminder uses one language according to the push subscription", () => {
    assert.equal(habitReminderBody(true, null, "ru"), "Время отметить активности на сегодня");
    assert.equal(habitReminderBody(true, null, "en"), "Time for today's activities");
    assert.equal(habitReminderBody(false, "Прогаю", "ru"), "Напоминание об активности: Прогаю");
    assert.equal(habitReminderBody(false, "Coding", "en"), "Activity reminder: Coding");
    assert.equal(planReminderBody("Покупки", "ru"), "Напоминание о плане: Покупки");
    assert.equal(planReminderBody("Shopping", "en"), "Plan reminder: Shopping");
});

test("old or unsupported subscription languages safely fall back to Russian", () => {
    for (const locale of [undefined, null, "", "fr", "EN"]) {
        assert.equal(normalizeReminderLanguage(locale), "ru");
        assert.equal(habitReminderBody(false, "Тест", locale), "Напоминание об активности: Тест");
        assert.equal(planReminderBody("Тест", locale), "Напоминание о плане: Тест");
    }
});

test("reminder names are still truncated to 90 characters", () => {
    assert.equal(habitReminderBody(false, "x".repeat(150), "en"), "Activity reminder: " + "x".repeat(90));
    assert.equal(planReminderBody("y".repeat(150), "ru"), "Напоминание о плане: " + "y".repeat(90));
});
