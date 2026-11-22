import test from "node:test";
import assert from "node:assert/strict";
import { parseGlobalQuery } from "../routes/search/global.js";

test("global search handles typed slash filters and plain queries", () => {
    assert.deepEqual(parseGlobalQuery("/ms врач"), {filter:"ms",query:"врач",like:"%врач%"});
    assert.equal(parseGlobalQuery("врач").filter,"every");
    for (const filter of ["com","post","user","habit","plan","group","every","new","setting"])
        assert.equal(parseGlobalQuery("/"+filter+" тест").filter,filter);
    assert.equal(parseGlobalQuery("/unknown тест"),null);
    assert.equal(parseGlobalQuery("/ms"),null);
    assert.equal(parseGlobalQuery(""),null);
    assert.equal(parseGlobalQuery("a".repeat(130)),null);
});
test("global search escapes SQL wildcards", () => {
    assert.equal(parseGlobalQuery("100%_hi").like, String.raw`%100\%\_hi%`);
});
