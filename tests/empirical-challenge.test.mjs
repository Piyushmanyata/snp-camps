/**
 * Empirical Stress Test Harness for #58 (QR Camera Session & Orchestrator).
 *
 * The mark_seen RPC stress tests live in empirical-challenge.db.test.mjs — they
 * need Postgres, and this suite must stay DB-free so a green run means green.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { QrCameraSession } from "../src/lib/qr-camera-session.ts";
import { QrDecodeOrchestrator } from "../src/lib/qr-decode-orchestrator.ts";

function createFakeStream(id) {
  const stopped = { count: 0 };
  const tracks = [
    {
      id: `${id}-track1`,
      stop() {
        stopped.count += 1;
      },
    },
    {
      id: `${id}-track2`,
      stop() {
        stopped.count += 1;
      },
    },
  ];
  return {
    id,
    stopped,
    getTracks() {
      return tracks;
    },
  };
}

// --------------------------------------------------------------------------
// SECTION 1: EMPIRICAL STRESS TESTS FOR QR CAMERA SESSION & ORCHESTRATOR (#58)
// --------------------------------------------------------------------------

test("STRESS: Rapid start/stop/unmount cycles & delayed acquire out-of-order resolution", async () => {
  const session = new QrCameraSession();
  const createdStreams = [];

  // Run 100 rapid cycles of begin / acquire / invalidate with delayed getUserMedia
  const acquirePromises = [];

  for (let i = 0; i < 100; i++) {
    const token = session.begin();
    const stream = createFakeStream(`stream-${i}`);
    createdStreams.push(stream);

    // Artificial random delay between 0 and 15ms before getUserMedia resolves
    const delay = Math.floor(Math.random() * 15);
    const getUserMedia = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(stream), delay);
      });

    const p = session.acquire(token, getUserMedia, { video: true });
    acquirePromises.push(p);

    if (i % 3 === 0) {
      session.invalidate();
    }
    if (i % 7 === 0) {
      session.begin();
    }
  }

  const results = await Promise.all(acquirePromises);

  // Verification:
  // 1. Only at most ONE result can be non-null (the current active session stream).
  const activeResults = results.filter((r) => r !== null);
  assert.ok(
    activeResults.length <= 1,
    `Expected at most 1 active stream, got ${activeResults.length}`,
  );

  if (activeResults.length === 1) {
    assert.equal(session.mediaStream, activeResults[0]);
  } else {
    assert.equal(session.mediaStream, null);
  }

  // 2. All streams that were rejected/superseded must have stopped tracks (stopped.count > 0).
  for (const stream of createdStreams) {
    if (stream !== session.mediaStream) {
      assert.ok(
        stream.stopped.count > 0,
        `Stream ${stream.id} was abandoned but tracks were not stopped!`,
      );
    }
  }
});

test("STRESS: getUserMedia failure / rejection does not crash session or leak state", async () => {
  const session = new QrCameraSession();
  const token = session.begin();

  const getUserMedia = () =>
    Promise.reject(new Error("NotAllowedError: Permission denied"));

  const stream = await session.acquire(token, getUserMedia, { video: true });
  assert.equal(stream, null);
  assert.equal(session.mediaStream, null);
  assert.equal(session.isCurrent(token), true);
});

test("STRESS: Orchestrator high-frequency state flapping & error handling during native detect", async () => {
  const session = new QrCameraSession();
  const token = session.begin();
  const decoded = [];

  const orch = new QrDecodeOrchestrator({
    isLive: () => session.isCurrent(token),
    onDecoded: (raw) => decoded.push(raw),
  });

  // Test 1: Native detect throwing an error should not leave inFlight = true
  const throwingDetect = async () => {
    throw new Error("Native BarcodeDetector internal error");
  };

  await assert.rejects(
    async () => {
      await orch.runNativeDetect({} /* mock source */, throwingDetect);
    },
    /Native BarcodeDetector internal error/,
  );

  // Verify orchestrator recovers and shouldRunFrame is true again
  assert.equal(orch.shouldRunFrame(), true);

  // Test 2: Rapid state flapping while detect is in-flight
  let resolveDetect;
  const slowDetectPromise = new Promise((resolve) => {
    resolveDetect = resolve;
  });

  const detectCall = orch.runNativeDetect(
    {},
    async () => slowDetectPromise,
  );

  // Flap states while in-flight
  orch.pause();
  orch.resume();
  orch.freeze();
  orch.unfreeze();

  // Resolve after session invalidation
  session.invalidate();
  resolveDetect([{ rawValue: "snp:patient-stale" }]);

  const fired = await detectCall;
  assert.equal(fired, false);
  assert.deepEqual(decoded, []);
});

test("STRESS: Synchronous decode under invalidation and freeze", () => {
  const session = new QrCameraSession();
  const token = session.begin();
  const decoded = [];

  const orch = new QrDecodeOrchestrator({
    isLive: () => session.isCurrent(token),
    onDecoded: (raw) => decoded.push(raw),
  });

  assert.equal(orch.runSyncDecode("snp:valid-qr"), true);
  assert.deepEqual(decoded, ["snp:valid-qr"]);

  session.invalidate();
  assert.equal(orch.runSyncDecode("snp:stale-qr"), false);
  assert.deepEqual(decoded, ["snp:valid-qr"]);
});
