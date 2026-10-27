import assert from "node:assert/strict";
import { test } from "node:test";
import { nextBatch } from "../salseo/downloads.js";

test("mobile batches limit memory and share count, and download large videos separately", () => {
  const small = Array.from({ length: 25 }, (_, id) => ({ id, size: 1024 }));
  assert.equal(nextBatch(small).length, 20);
  const large = { id: "video", size: 100 * 1024 * 1024 };
  assert.deepEqual(nextBatch([large, ...small]), [large]);
  const medium = { id: "clip", size: 40 * 1024 * 1024 };
  assert.deepEqual(nextBatch([medium, medium]), [medium]);
  assert.deepEqual(nextBatch([]), []);
});
