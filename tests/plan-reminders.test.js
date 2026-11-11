import test from "node:test";
import assert from "node:assert/strict";
import { validPlanReminderOffsets } from "../routes/plans/reminders.js";

test("plan reminder offsets allow eight distinct positive values up to one week", () => {
    assert.equal(validPlanReminderOffsets([]), true);
    assert.equal(validPlanReminderOffsets([10,60,1440,10080]), true);
    assert.equal(validPlanReminderOffsets([1,2,3,4,5,6,7,8]), true);
    assert.equal(validPlanReminderOffsets([0]), false);
    assert.equal(validPlanReminderOffsets([10081]), false);
    assert.equal(validPlanReminderOffsets([10,10]), false);
    assert.equal(validPlanReminderOffsets([1,2,3,4,5,6,7,8,9]), false);
    assert.equal(validPlanReminderOffsets(["60"]), false);
});
