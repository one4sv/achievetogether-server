import test from "node:test";
import assert from "node:assert/strict";
import { validateOneOffPlanInput } from "../routes/plans/plans.js";

const base = { name: "One-time meeting", plan_date: "2026-11-20" };

test("one-off plans accept date without time", () => {
    assert.deepEqual(validateOneOffPlanInput(base, true), {
        ...base, kind: "personal", completion_mode: "personal",
        timezone: "Europe/Moscow", visibility: "nobody", join_mode: "invite"
    });
});
test("invalid dates and time formats are rejected", () => {
    assert.equal(validateOneOffPlanInput({ ...base, plan_date: "2026-02-30" }, true), null);
    assert.equal(validateOneOffPlanInput({ ...base, start_time: "24:01" }, true), null);
    assert.equal(validateOneOffPlanInput({ ...base, start_time: "14:00", end_time: "13:59" }, true), null);
});
test("shared plans support either completion mode", () => {
    for (const mode of ["personal", "shared"]) {
        assert.equal(validateOneOffPlanInput({ ...base, kind:"shared", completion_mode:mode }, true)?.completion_mode, mode);
    }
    assert.equal(validateOneOffPlanInput({ ...base, kind:"personal", completion_mode:"shared" }, true), null);
});
test("arbitrary fields and long names cannot be inserted", () => {
    assert.equal(validateOneOffPlanInput({ ...base, owner_id:"someone-else" }, true), null);
    assert.equal(validateOneOffPlanInput({ ...base, name:"x".repeat(161) }, true), null);
    assert.equal(validateOneOffPlanInput({ ...base, timezone:"Mars/Phobos" }, true), null);
});
test("partial updates cannot change ownership or type", () => {
    assert.deepEqual(validateOneOffPlanInput({ name:"  Renamed plan  " }), { name:"Renamed plan" });
    assert.equal(validateOneOffPlanInput({ created_at:"2026-01-01" }), null);
});
