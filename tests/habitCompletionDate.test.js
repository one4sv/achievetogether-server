import test from "node:test";
import assert from "node:assert/strict";
import { canCompleteHabitDay, moscowDate } from "../utils/habitCompletionDate.js";

test("joining day uses Moscow timezone", () => {
    assert.equal(moscowDate("2026-11-01T22:30:00Z"), "2026-11-02");
    assert.equal(moscowDate("2026-11-01T20:30:00Z"), "2026-11-01");
});

test("member cannot complete a date before chat join, including shared completion", () => {
    const access = { habit: { chat_id: 42 }, is_owner: false, completion_start_date: "2026-11-02" };
    assert.equal(canCompleteHabitDay(access, "2026-11-01"), false);
    assert.equal(canCompleteHabitDay(access, "2026-11-02"), true);
    assert.equal(canCompleteHabitDay(access, "2026-11-03"), true);
});

test("owner and non-chat activities preserve historical completion", () => {
    assert.equal(canCompleteHabitDay({ habit: { chat_id: 42 }, is_owner: true }, "2026-10-01"), true);
    assert.equal(canCompleteHabitDay({ habit: { chat_id: null }, is_owner: false }, "2026-10-01"), true);
});

test("nonmember of linked chat cannot mark past days and invalid dates fail", () => {
    const access = { habit: { chat_id: 42 }, is_owner: false, completion_start_date: null };
    assert.equal(canCompleteHabitDay(access, "2026-11-02"), false);
    assert.equal(canCompleteHabitDay(access, "01/11/2026"), false);
    assert.equal(canCompleteHabitDay(access, null), false);
});
