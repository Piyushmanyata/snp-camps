/**
 * #58 — Camera session generation + decode orchestrator cancellation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { QrCameraSession } from "../src/lib/qr-camera-session.ts";
import { QrDecodeOrchestrator } from "../src/lib/qr-decode-orchestrator.ts";

function fakeStream(id = "t1") {
  const stopped = { n: 0 };
  return {
    id,
    stopped,
    getTracks() {
      return [
        {
          stop() {
            stopped.n += 1;
          },
        },
      ];
    },
  };
}

test("freeze after terminal exhaustion blocks same-code re-arm until unfreeze (#61)", async () => {
  const session = new QrCameraSession();
  const token = session.begin();
  /** @type {string[]} */
  const decoded = [];
  const orch = new QrDecodeOrchestrator({
    isLive: () => session.isCurrent(token),
    onDecoded: (raw) => decoded.push(raw),
  });

  orch.freeze();
  assert.equal(orch.isFrozen, true);
  assert.equal(orch.shouldRunFrame(), false);

  const firedNative = await orch.runNativeDetect(
    /** @type {never} */ ({}),
    async () => [{ rawValue: "snp:same-qr-again" }],
  );
  assert.equal(firedNative, false);
  assert.equal(orch.runSyncDecode("snp:same-qr-again"), false);
  assert.deepEqual(decoded, []);

  // Explicit operator recovery only.
  orch.unfreeze();
  assert.equal(orch.isFrozen, false);
  assert.equal(orch.shouldRunFrame(), true);
  assert.equal(orch.runSyncDecode("snp:same-qr-again"), true);
  assert.deepEqual(decoded, ["snp:same-qr-again"]);
});

test("stop during pending detect produces no callback", async () => {
  const session = new QrCameraSession();
  const token = session.begin();
  /** @type {string[]} */
  const decoded = [];
  let resolveDetect;
  const detectPromise = new Promise((resolve) => {
    resolveDetect = resolve;
  });

  const orch = new QrDecodeOrchestrator({
    isLive: () => session.isCurrent(token),
    onDecoded: (raw) => decoded.push(raw),
  });

  const pending = orch.runNativeDetect(
    /** @type {never} */ ({}),
    async () => detectPromise,
  );

  session.invalidate();
  resolveDetect([{ rawValue: "snp:patient-should-not-fire" }]);
  const fired = await pending;

  assert.equal(fired, false);
  assert.deepEqual(decoded, []);
  assert.equal(session.isCurrent(token), false);
});

test("unmount-style invalidate after acquire stops tracks and rejects stale stream", async () => {
  const session = new QrCameraSession();
  const token = session.begin();
  let resolveGum;
  const gumPromise = new Promise((resolve) => {
    resolveGum = resolve;
  });

  const acquirePromise = session.acquire(
    token,
    async () => gumPromise,
    { video: true, audio: false },
  );

  const stream = fakeStream("stale");
  session.invalidate();
  resolveGum(stream);
  const result = await acquirePromise;

  assert.equal(result, null);
  assert.equal(stream.stopped.n, 1);
  assert.equal(session.mediaStream, null);
});

test("rapid begin A then B does not keep A's stream", async () => {
  const session = new QrCameraSession();
  const tokenA = session.begin();
  const streamA = fakeStream("A");
  await session.acquire(tokenA, async () => streamA, { video: true });
  assert.equal(session.mediaStream, streamA);

  const tokenB = session.begin();
  assert.equal(streamA.stopped.n, 1);
  assert.equal(session.mediaStream, null);

  const streamB = fakeStream("B");
  const got = await session.acquire(tokenB, async () => streamB, {
    video: true,
  });
  assert.equal(got, streamB);
  assert.equal(session.isCurrent(tokenA), false);
  assert.equal(session.isCurrent(tokenB), true);
});

test("pause then delayed detect does not callback; resume allows next", async () => {
  const session = new QrCameraSession();
  const token = session.begin();
  /** @type {string[]} */
  const decoded = [];
  const orch = new QrDecodeOrchestrator({
    isLive: () => session.isCurrent(token),
    onDecoded: (raw) => decoded.push(raw),
  });

  orch.pause();
  let resolveDetect;
  const p = orch.runNativeDetect(/** @type {never} */ ({}), async () => {
    return new Promise((r) => {
      resolveDetect = r;
    });
  });
  // shouldRunFrame is false while paused — runNativeDetect returns early
  const early = await p;
  assert.equal(early, false);

  orch.resume();
  const ok = await orch.runNativeDetect(/** @type {never} */ ({}), async () => [
    { rawValue: "snp:ok" },
  ]);
  assert.equal(ok, true);
  assert.deepEqual(decoded, ["snp:ok"]);
  // silence unused
  void resolveDetect;
});

test("freeze blocks auto re-decode until unfreeze", async () => {
  const session = new QrCameraSession();
  const token = session.begin();
  /** @type {string[]} */
  const decoded = [];
  const orch = new QrDecodeOrchestrator({
    isLive: () => session.isCurrent(token),
    onDecoded: (raw) => decoded.push(raw),
  });

  orch.freeze();
  const blocked = await orch.runNativeDetect(
    /** @type {never} */ ({}),
    async () => [{ rawValue: "snp:loop" }],
  );
  assert.equal(blocked, false);
  assert.deepEqual(decoded, []);

  orch.unfreeze();
  const ok = await orch.runNativeDetect(
    /** @type {never} */ ({}),
    async () => [{ rawValue: "snp:loop" }],
  );
  assert.equal(ok, true);
  assert.deepEqual(decoded, ["snp:loop"]);
});

test("debounce ignores same raw QR after mark-seen", async () => {
  const session = new QrCameraSession();
  const token = session.begin();
  /** @type {string[]} */
  const decoded = [];
  const orch = new QrDecodeOrchestrator({
    isLive: () => session.isCurrent(token),
    onDecoded: (raw) => decoded.push(raw),
    debounceMs: 60_000,
  });

  orch.debounceRawValue("snp:same");
  const blocked = await orch.runNativeDetect(
    /** @type {never} */ ({}),
    async () => [{ rawValue: "snp:same" }],
  );
  assert.equal(blocked, false);

  const ok = await orch.runNativeDetect(
    /** @type {never} */ ({}),
    async () => [{ rawValue: "snp:other" }],
  );
  assert.equal(ok, true);
  assert.deepEqual(decoded, ["snp:other"]);
});

test("single in-flight: second detect waits for first to finish", async () => {
  const session = new QrCameraSession();
  const token = session.begin();
  /** @type {string[]} */
  const decoded = [];
  const orch = new QrDecodeOrchestrator({
    isLive: () => session.isCurrent(token),
    onDecoded: (raw) => decoded.push(raw),
  });

  let resolveFirst;
  const first = orch.runNativeDetect(/** @type {never} */ ({}), async () => {
    return new Promise((r) => {
      resolveFirst = r;
    });
  });

  // While in-flight, shouldRunFrame is false
  const second = await orch.runNativeDetect(
    /** @type {never} */ ({}),
    async () => [{ rawValue: "snp:second" }],
  );
  assert.equal(second, false);

  resolveFirst([{ rawValue: "snp:first" }]);
  assert.equal(await first, true);
  assert.deepEqual(decoded, ["snp:first"]);
});
