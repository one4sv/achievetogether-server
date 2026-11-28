import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { CHAT_MEDIA_LIMIT, chatAttachmentStorage, ensureChatMediaLimit } from "../utils/chatMediaLimit.js";

const upload = (req, size) => new Promise((resolve, reject) => {
  const stream = Readable.from((function* () {
    for (let left = size; left > 0;) {
      const bytes = Math.min(left, 1024 * 1024);
      left -= bytes;
      yield Buffer.alloc(bytes);
    }
  })());
  chatAttachmentStorage._handleFile(req, { stream }, (error, value) => error ? reject(error) : resolve(value));
});

test("chat accepts more than 10 MiB and bounds total attachment bytes", async () => {
  const req = {};
  const first = await upload(req, 12 * 1024 * 1024);
  assert.equal(first.size, 12 * 1024 * 1024);
  await assert.rejects(upload(req, CHAT_MEDIA_LIMIT - first.size + 1), { code: "CHAT_TOTAL_FILE_SIZE" });
});

test("bucket configuration updates only the known private legacy limit", async () => {
  const calls = [];
  const storage = {
    getBucket: async () => ({ data: { public: false, file_size_limit: 10485760, allowed_mime_types: null } }),
    updateBucket: async (...args) => { calls.push(args); return { error: null }; }
  };
  await ensureChatMediaLimit({ storage });
  assert.deepEqual(calls, [["media", { public: false, fileSizeLimit: CHAT_MEDIA_LIMIT, allowedMimeTypes: null }]]);
  storage.getBucket = async () => ({ data: { public: false, file_size_limit: 1234, allowed_mime_types: null } });
  await ensureChatMediaLimit({ storage });
  assert.equal(calls.length, 1);
});
