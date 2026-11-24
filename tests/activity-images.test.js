import assert from "node:assert/strict";
import test from "node:test";
import {keys,validPhoto} from "../utils/activityImages.js";

test("attachments must be distinct IDs, capped at four",()=>{
    const id="cd6f05f5-a141-4a79-af14-2e564070fedf";
    assert.deepEqual(keys(JSON.stringify([id])),[id]);
    for(const value of ["null","invalid",JSON.stringify([id,id]),'["path/to/file"]'])assert.equal(keys(value),null);
});
test("image validator checks JPEG frame dimensions and upload bounds",()=>{
    const buffer=Buffer.from("ffd8ffc00011080080010003012200021101031101ffd9","hex");
    const file={mimetype:"image/jpeg",buffer};
    assert.equal(validPhoto(file,512),true);
    assert.equal(validPhoto(file,128),false);
    assert.equal(validPhoto({...file,mimetype:"text/html"},512),false);
    assert.equal(validPhoto({...file,buffer:Buffer.from("not a picture")},512),false);
});

