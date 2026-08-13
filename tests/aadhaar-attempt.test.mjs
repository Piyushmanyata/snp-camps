/**
 * ADR 0014 — one Aadhaar attempt produces one outcome.
 *
 * The phone's built-in reader returns text and can look like a hit while the
 * real binary payload is unread. Only a genuinely parsed card may suppress the
 * binary reader; anything else is a hint that must not end the attempt.
 *
 * The client is injected, so this exercises the real sequencing without the
 * worker (which calls Comlink.expose at module top level and cannot be
 * imported by node).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { attemptAadhaarDecode } from "../src/lib/aadhaar-attempt.ts";

const CARD = {
  status: "parsed",
  parsed: { name: "Test Patient" },
  diagnostic: "kind=secure-qr",
};
const NOT_AADHAAR = {
  status: "rejected",
  message: "That is our own desk slip, not an Aadhaar card.",
  diagnostic: "kind=desk-slip",
};
const GARBAGE = {
  status: "malformed",
  message: "A QR was found, but its Aadhaar data was incomplete.",
  diagnostic: "kind=partial",
};
const NOTHING = { status: "none" };

/** Records what the attempt asked of the decoder, in order. */
function fakeClient({ payload = NOTHING, frame = NOTHING } = {}) {
  const calls = [];
  return {
    calls,
    async decodePayload(text) {
      calls.push(["decodePayload", text]);
      return typeof payload === "function" ? payload(text) : payload;
    },
    async decodeFrame(image, thorough) {
      calls.push(["decodeFrame", image, thorough]);
      return typeof frame === "function" ? frame(image, thorough) : frame;
    },
  };
}

const IMAGE = { width: 640, height: 480 };

test("a parsed card from the native hint is the whole attempt", async () => {
  const client = fakeClient({ payload: CARD, frame: GARBAGE });
  const outcome = await attemptAadhaarDecode({
    image: IMAGE,
    nativeText: "<PrintLetterBarcodeData …>",
    client,
  });

  assert.equal(outcome.status, "parsed");
  assert.deepEqual(
    client.calls.map((c) => c[0]),
    ["decodePayload"],
    "a real card must not pay for the binary reader as well",
  );
});

test("a rejected native hit still runs the binary reader on the same picture", async () => {
  // The defect ADR 0014 exists for: a mangled native text hit on a good card
  // suppressed the WASM reader and the card never got read.
  const client = fakeClient({ payload: NOT_AADHAAR, frame: CARD });
  const outcome = await attemptAadhaarDecode({
    image: IMAGE,
    nativeText: "garbled text the phone reader produced",
    client,
  });

  assert.equal(outcome.status, "parsed", "the binary reader must get its turn");
  assert.deepEqual(client.calls.map((c) => c[0]), [
    "decodePayload",
    "decodeFrame",
  ]);
});

test("a malformed native hit still runs the binary reader", async () => {
  const client = fakeClient({ payload: GARBAGE, frame: CARD });
  const outcome = await attemptAadhaarDecode({
    image: IMAGE,
    nativeText: "partial",
    client,
  });

  assert.equal(outcome.status, "parsed");
  assert.deepEqual(client.calls.map((c) => c[0]), [
    "decodePayload",
    "decodeFrame",
  ]);
});

test("when the binary reader finds nothing, the hint's reason survives", async () => {
  // Not-Aadhaar is what stops the session (story 32). Collapsing it to `none`
  // would silently keep the camera open on our own desk slip.
  const client = fakeClient({ payload: NOT_AADHAAR, frame: NOTHING });
  const outcome = await attemptAadhaarDecode({
    image: IMAGE,
    nativeText: "snp:desk-slip",
    client,
  });

  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.message, NOT_AADHAAR.message);
});

test("no native text at all goes straight to the binary reader", async () => {
  const client = fakeClient({ frame: CARD });
  const outcome = await attemptAadhaarDecode({ image: IMAGE, client });

  assert.equal(outcome.status, "parsed");
  assert.deepEqual(client.calls.map((c) => c[0]), ["decodeFrame"]);
});

test("empty native text is not offered to the decoder", async () => {
  const client = fakeClient({ frame: NOTHING });
  await attemptAadhaarDecode({ image: IMAGE, nativeText: "   ", client });

  assert.deepEqual(client.calls.map((c) => c[0]), ["decodeFrame"]);
});

test("the thorough flag reaches the binary reader unchanged", async () => {
  const client = fakeClient({ frame: NOTHING });
  await attemptAadhaarDecode({ image: IMAGE, client, thorough: true });

  assert.deepEqual(client.calls[0], ["decodeFrame", IMAGE, true]);
});

test("a USB wedge payload is one attempt with no picture", async () => {
  const client = fakeClient({ payload: CARD });
  const outcome = await attemptAadhaarDecode({
    nativeText: "<PrintLetterBarcodeData …>",
    client,
  });

  assert.equal(outcome.status, "parsed");
  assert.deepEqual(client.calls.map((c) => c[0]), ["decodePayload"]);
});

test("a USB wedge payload that is not a card reports why, not nothing", async () => {
  const client = fakeClient({ payload: NOT_AADHAAR });
  const outcome = await attemptAadhaarDecode({
    nativeText: "snp:desk-slip",
    client,
  });

  assert.equal(outcome.status, "rejected");
});

test("neither a picture nor text is nothing, not a crash", async () => {
  const client = fakeClient();
  const outcome = await attemptAadhaarDecode({ client });

  assert.deepEqual(outcome, { status: "none" });
  assert.deepEqual(client.calls, []);
});

test("both readers finding nothing is one `none` outcome", async () => {
  const client = fakeClient({ payload: NOTHING, frame: NOTHING });
  const outcome = await attemptAadhaarDecode({
    image: IMAGE,
    nativeText: "something the phone saw",
    client,
  });

  assert.deepEqual(outcome, { status: "none" });
  assert.deepEqual(client.calls.map((c) => c[0]), [
    "decodePayload",
    "decodeFrame",
  ]);
});

test("a binary `none` never downgrades a malformed hint", async () => {
  const client = fakeClient({ payload: GARBAGE, frame: NOTHING });
  const outcome = await attemptAadhaarDecode({
    image: IMAGE,
    nativeText: "partial",
    client,
  });

  assert.equal(outcome.status, "malformed");
  assert.equal(outcome.message, GARBAGE.message);
});
