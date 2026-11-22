import test from "node:test";
import assert from "node:assert/strict";
import { mentionedMemberIds, shouldNotifyMessage } from "../utils/mentions.js";

const members = [
    {user_id: "sender", is_blocked: false},
    {user_id: "alice", is_blocked: false},
    {user_id: "bob", is_blocked: false},
    {user_id: "hidden", is_blocked: true}
];
const profiles = [
    {id: "sender", nick: "author"}, {id: "alice", nick: "Alice"},
    {id: "bob", nick: "b_ob"}, {id: "hidden", nick: "hidden"},
    {id: "stranger", nick: "stranger"}
];

test("only explicit, actual chat members can be mentioned", () => {
    assert.deepEqual([...mentionedMemberIds("@Alice, hi @b_ob @alice!", profiles, members, "sender")].sort(), ["alice","bob"]);
    assert.deepEqual([...mentionedMemberIds("@hidden @stranger @author", profiles, members, "sender")], []);
    assert.deepEqual([...mentionedMemberIds("https://a.test/@Alice and x@b_ob", profiles, members, "sender")], []);
    assert.deepEqual([...mentionedMemberIds("Hi, @Alice.", profiles, members, "sender")], ["alice"]);
});

test("muted chat and new-message toggle do not suppress opted-in mentions", () => {
    assert.equal(shouldNotifyMessage({allNote:true,newMessNote:false,mentionsNote:true,chatNote:false,isMention:true}),true);
    assert.equal(shouldNotifyMessage({allNote:true,newMessNote:true,mentionsNote:false,chatNote:false,isMention:true}),false);
    assert.equal(shouldNotifyMessage({allNote:true,newMessNote:true,mentionsNote:false,chatNote:true,isMention:false}),true);
    assert.equal(shouldNotifyMessage({allNote:false,newMessNote:true,mentionsNote:true,chatNote:true,isMention:true}),false);
});
