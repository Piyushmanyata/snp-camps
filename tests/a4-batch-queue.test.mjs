/**
 * A4 station batch queue (#64) — distinct IDs only, max 4, no PII in storage.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  A4_BATCH_MAX,
  A4_BATCH_STORAGE_KEY,
  a4BatchCount,
  a4BatchIds,
  a4BatchIsEmpty,
  a4BatchIsFull,
  a4BatchPreviewPath,
  a4BatchPrintPath,
  addToA4Batch,
  clearA4Batch,
  emptyA4BatchQueue,
  parseA4BatchIdsParam,
  parseA4BatchQueue,
} from "../src/lib/a4-batch-queue.ts";

const ID1 = "aaaaaaaa-bbbb-4ccc-8ddd-111111111111";
const ID2 = "aaaaaaaa-bbbb-4ccc-8ddd-222222222222";
const ID3 = "aaaaaaaa-bbbb-4ccc-8ddd-333333333333";
const ID4 = "aaaaaaaa-bbbb-4ccc-8ddd-444444444444";
const ID5 = "aaaaaaaa-bbbb-4ccc-8ddd-555555555555";

test("empty queue constants", () => {
  const q = emptyA4BatchQueue();
  assert.equal(A4_BATCH_MAX, 4);
  assert.equal(A4_BATCH_STORAGE_KEY, "snp.a4BatchQueue");
  assert.equal(a4BatchCount(q), 0);
  assert.equal(a4BatchIsEmpty(q), true);
  assert.equal(a4BatchIsFull(q), false);
  assert.deepEqual(a4BatchIds(q), []);
});

test("addToA4Batch keeps distinct ids in order up to four", () => {
  let q = emptyA4BatchQueue();
  let r = addToA4Batch(q, ID1, 1000);
  assert.equal(r.added, true);
  q = r.queue;
  r = addToA4Batch(q, ID2, 2000);
  assert.equal(r.added, true);
  q = r.queue;
  r = addToA4Batch(q, ID3, 3000);
  q = r.queue;
  r = addToA4Batch(q, ID4, 4000);
  q = r.queue;
  assert.equal(a4BatchCount(q), 4);
  assert.equal(a4BatchIsFull(q), true);
  assert.deepEqual(a4BatchIds(q), [ID1, ID2, ID3, ID4]);
  // Never duplicate merely to fill.
  r = addToA4Batch(q, ID5, 5000);
  assert.equal(r.added, false);
  assert.equal(r.reason, "full");
  assert.deepEqual(a4BatchIds(r.queue), [ID1, ID2, ID3, ID4]);
});

test("duplicate id is rejected without growing the queue", () => {
  let q = emptyA4BatchQueue();
  q = addToA4Batch(q, ID1, 1).queue;
  const r = addToA4Batch(q, ID1.toUpperCase(), 2);
  assert.equal(r.added, false);
  assert.equal(r.reason, "duplicate");
  assert.equal(a4BatchCount(r.queue), 1);
});

test("invalid uuid is rejected", () => {
  const r = addToA4Batch(emptyA4BatchQueue(), "not-a-uuid");
  assert.equal(r.added, false);
  assert.equal(r.reason, "invalid");
});

test("parseA4BatchQueue strips PII-like keys and invalid ids; bounds to 4", () => {
  const parsed = parseA4BatchQueue({
    v: 1,
    entries: [
      {
        id: ID1,
        addedAt: 1,
        full_name: "SECRET",
        phone: "9999999999",
        status_token: "tok",
      },
      { id: "bad", addedAt: 2 },
      { id: ID1, addedAt: 3 }, // dup
      { id: ID2, addedAt: 4 },
      { id: ID3, addedAt: 5 },
      { id: ID4, addedAt: 6 },
      { id: ID5, addedAt: 7 },
    ],
  });
  assert.deepEqual(a4BatchIds(parsed), [ID1, ID2, ID3, ID4]);
  for (const e of parsed.entries) {
    assert.deepEqual(Object.keys(e).sort(), ["addedAt", "id"]);
  }
});

test("clearA4Batch empties", () => {
  let q = emptyA4BatchQueue();
  q = addToA4Batch(q, ID1, 1).queue;
  q = clearA4Batch();
  assert.equal(a4BatchIsEmpty(q), true);
});

test("parseA4BatchIdsParam de-dupes and bounds", () => {
  assert.deepEqual(parseA4BatchIdsParam(`${ID1},${ID2},bad,${ID1},${ID3},${ID4},${ID5}`), [
    ID1,
    ID2,
    ID3,
    ID4,
  ]);
  assert.deepEqual(parseA4BatchIdsParam(null), []);
});

test("batch print paths encode distinct ids only", () => {
  assert.equal(a4BatchPreviewPath([]), "/print/batch");
  assert.match(a4BatchPrintPath([ID1, ID2]), /\/print\/batch\?ids=/);
  assert.match(a4BatchPrintPath([ID1]), /auto=1/);
  assert.doesNotMatch(a4BatchPreviewPath([ID1]), /auto=/);
});
