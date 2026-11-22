import assert from "node:assert/strict";
import test from "node:test";
import { postCardExcerpt } from "../utils/sharedEntity.js";
import { parseGlobalQuery } from "../routes/search/global.js";
test("post preview reads rich text without JSON or markup", () => {
    assert.equal(postCardExcerpt(JSON.stringify({type:"doc",content:[
        {type:"paragraph",content:[{type:"text",text:"Hello "},{type:"text",text:"world"}]}]})), "Hello  world");
    assert.equal(postCardExcerpt("One\nTwo"), "One Two");
});
test("explicit share commands list current accessible entities without extra typing", () => {
    for(const type of ["user","habit","plan","post","group"])
        assert.deepEqual(parseGlobalQuery("/"+type).filter,type);
    assert.equal(parseGlobalQuery("/ms"),null);
    assert.equal(parseGlobalQuery("/every"),null);
});
