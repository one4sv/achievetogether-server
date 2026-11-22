import test from "node:test";
import assert from "node:assert/strict";
import { parseGlobalQuery, sortGlobalSearchResults } from "../routes/search/global.js";

test("global search handles typed slash filters and plain queries", () => {
    assert.deepEqual(parseGlobalQuery("/ms врач"), {filter:"ms",query:"врач",like:"%врач%"});
    assert.equal(parseGlobalQuery("врач").filter,"every");
    for (const filter of ["com","post","user","habit","plan","group","every","new","setting"])
        assert.equal(parseGlobalQuery("/"+filter+" тест").filter,filter);
    assert.equal(parseGlobalQuery("/unknown тест"),null);
    assert.deepEqual(parseGlobalQuery("/ms"), {filter:"ms",query:"",like:"%%"});
    assert.deepEqual(parseGlobalQuery("/new"), {filter:"new",query:"",like:"%%"});
    assert.equal(parseGlobalQuery(""),null);
    assert.equal(parseGlobalQuery("/setting"),null);
    assert.equal(parseGlobalQuery("a".repeat(130)),null);
});
test("global search escapes SQL wildcards", () => {
    assert.equal(parseGlobalQuery("100%_hi").like, String.raw`%100\%\_hi%`);
});

test("global search prioritizes owned activities, plans and posts within a category", () => {
    const rows = [
        { id:"other-new", mine:false, date:"2026-11-22T20:00:00Z" },
        { id:"mine-old", mine:true, date:"2026-10-01T20:00:00Z" },
        { id:"mine-new", mine:true, date:"2026-11-01T20:00:00Z" }
    ];
    for (const type of ["habit","plan","post"]) {
        assert.deepEqual(sortGlobalSearchResults(rows.slice(), type).map(row => row.id),
            ["mine-new","mine-old","other-new"]);
    }
    assert.deepEqual(sortGlobalSearchResults(rows.slice(), "ms").map(row => row.id),
        ["other-new","mine-new","mine-old"]);
});
