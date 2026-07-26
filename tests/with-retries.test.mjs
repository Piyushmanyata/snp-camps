/**
 * Shared quiet-retry helper (#47 pattern extracted for #32).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  RETRY_EXHAUSTED_COPY,
  withRetries,
} from "../src/lib/with-retries.ts";

test("retries twice with 250 then 750 ms backoff by default", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await withRetries(
    async () => {
      calls += 1;
      return { error: "blip" };
    },
    {
      shouldRetry: (r) => Boolean(r.error),
      mapExhausted: () => ({ error: RETRY_EXHAUSTED_COPY.lookup }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [250, 750]);
  assert.equal(result.error, RETRY_EXHAUSTED_COPY.lookup);
});

test("stops on first non-retryable result", async () => {
  let calls = 0;
  const result = await withRetries(
    async () => {
      calls += 1;
      return { error: null, data: 1 };
    },
    {
      shouldRetry: (r) => Boolean(r.error),
      sleep: async () => {},
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.data, 1);
});

test("success on second attempt does not take third", async () => {
  let calls = 0;
  const result = await withRetries(
    async () => {
      calls += 1;
      if (calls === 1) return { error: "temp" };
      return { error: null, data: "ok" };
    },
    {
      shouldRetry: (r) => Boolean(r.error),
      sleep: async () => {},
    },
  );
  assert.equal(calls, 2);
  assert.equal(result.data, "ok");
});
