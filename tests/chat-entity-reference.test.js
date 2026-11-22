import test from "node:test";
import assert from "node:assert/strict";
import { validEntityReference, sharedEntityPreview } from "../utils/sharedEntity.js";
test("only typed IDs can become reference cards", () => {
    for (const kind of ["plan","habit","post","group"]) {
        assert.equal(validEntityReference(kind,"123"),true);
        assert.equal(validEntityReference(kind,"0"),false);
        assert.equal(validEntityReference(kind,"1 OR true"),false);
    }
    assert.equal(validEntityReference("invite","123"),false);
    assert.equal(validEntityReference("user","00000000-0000-0000-0000-000000000001"),true);
    assert.equal(validEntityReference("user","alice"),false);
});
test("invalid reference never queries object data", async () => {
    assert.equal(await sharedEntityPreview({}, "plan", "1", null),null);
    assert.equal(await sharedEntityPreview({}, "habit", "-1", "viewer"),null);
});
