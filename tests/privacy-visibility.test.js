import test from "node:test";
import assert from "node:assert/strict";
import { permitted,validatePrivacy,isShareToken } from "../utils/privacy.js";
const owner = "11111111-1111-4111-8111-111111111111";
const viewer = "22222222-2222-4222-8222-222222222222";
const token = "33333333-3333-4333-8333-333333333333";
test("link access requires an unguessable matching token",() => {
    const base = { rules:{ plans:"link" },field:"plans",ownerId:owner,viewerId:null,token };
    assert.equal(permitted(base),false);
    assert.equal(permitted({ ...base,share:"123" }),false);
    assert.equal(permitted({ ...base,share:token }),true);
    assert.equal(permitted({ ...base,share:token,blocked:true }),false);
    assert.equal(isShareToken("1",token),false);
});
test("owner, contact, exception and block policies are independent",() => {
    const base={ rules:{ posts:"contacts" },field:"posts",ownerId:owner,viewerId:viewer };
    assert.equal(permitted(base),false);
    assert.equal(permitted({ ...base,contact:true }),true);
    assert.equal(permitted({ ...base,blocked:true,contact:true }),false);
    assert.equal(permitted({ ...base,rules:{ posts:"nobody",posts_exceptions:{ [viewer]:"invert" } } }),true);
    assert.equal(permitted({ ...base,rules:{ posts:"all",posts_exceptions:{ [viewer]:"deny" } } }),false);
    assert.equal(permitted({ ...base,viewerId:owner }),true);
});
test("privacy settings reject malformed rules, UUID exceptions, and excessive entries",() => {
    assert.equal(validatePrivacy({plans:"link"})?.plans,"link");
    assert.equal(validatePrivacy({profile:"link"})?.profile,"link");
    assert.equal(validatePrivacy({plan_invites:"all"})?.plan_invites,"all");
    assert.equal(validatePrivacy({plans:"open"}),null);
    assert.equal(validatePrivacy({bad:true}),null);
    assert.equal(validatePrivacy({habits_exceptions:{ abc:"allow" }}),null);
    assert.equal(validatePrivacy({posts_exceptions:{ [viewer]:"invert" }})?.posts_exceptions[viewer],"invert");
});
