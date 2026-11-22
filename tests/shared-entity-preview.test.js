import assert from "node:assert/strict";
import test from "node:test";
import { postCardExcerpt } from "../utils/sharedEntity.js";
import { parseGlobalQuery } from "../routes/search/global.js";
test("post preview reads rich text without JSON or markup", () => {
    assert.equal(postCardExcerpt(JSON.stringify({type:"doc",content:[
        {type:"paragraph",content:[{type:"text",text:"Hello "},{type:"text",text:"world"}]}]})), "Hello world");
    assert.equal(postCardExcerpt("One\nTwo"), "One Two");
    const longText = "a".repeat(900);
    assert.equal(postCardExcerpt(longText).length, 700);
    assert.equal(postCardExcerpt(longText).slice(-1), "a");
});
test("explicit share commands list current accessible entities without extra typing", () => {
    for(const type of ["user","habit","plan","post","group"])
        assert.deepEqual(parseGlobalQuery("/"+type).filter,type);
    assert.deepEqual(parseGlobalQuery("/ms"), {filter:"ms",query:"",like:"%%"});
    assert.deepEqual(parseGlobalQuery("/new"), {filter:"new",query:"",like:"%%"});
    assert.equal(parseGlobalQuery("/every"),null);
});
