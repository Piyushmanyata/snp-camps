/**
 * Bounds for Secure QR numeric→bytes (adversarial review Phase E).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { numericStringToBytes } from "../src/lib/aadhaar-qr.ts";

test("numericStringToBytes matches BigInt for short payloads", () => {
  const text = "12345678901234567890";
  const got = numericStringToBytes(text);
  let big = BigInt(text);
  const expected = [];
  while (big > 0n) {
    expected.push(Number(big & 0xffn));
    big >>= 8n;
  }
  expected.reverse();
  assert.deepEqual([...got], expected);
});

test("numericStringToBytes finishes long digit strings within a budget", () => {
  // ~400 digits — long enough to stress full-string BigInt on slow paths.
  const text = "9".repeat(400);
  const started = performance.now();
  const bytes = numericStringToBytes(text);
  const elapsed = performance.now() - started;
  assert.ok(bytes.length > 0);
  // Generous CI-friendly bound; production path must stay well under this.
  assert.ok(
    elapsed < 500,
    `numericStringToBytes took ${elapsed.toFixed(1)}ms (budget 500ms)`,
  );
});

test("numericStringToBytes long path matches BigInt for 200–400 digit fixtures", () => {
  for (const text of ["1" + "0".repeat(199), "9876543210".repeat(30), "9".repeat(400)]) {
    const got = numericStringToBytes(text);
    let big = BigInt(text);
    const expected = [];
    while (big > 0n) {
      expected.push(Number(big & 0xffn));
      big >>= 8n;
    }
    expected.reverse();
    assert.deepEqual(
      [...got],
      expected,
      `mismatch for length ${text.length}`,
    );
  }
});

test("likely-duplicate path must not return status links (source guard)", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(
    join(process.cwd(), "src/app/api/self-registration/route.ts"),
    "utf8",
  );
  // Soft matches must stay desk-referral only — never open status_token recovery.
  assert.match(src, /likelyDup\?\.regNo/);
  assert.match(src, /deskReferral:\s*true/);
  assert.doesNotMatch(
    src,
    /aadhaarDup\?\.regNo\s*\?\?\s*likelyDup/,
  );
});

test("MAX_DECODE_EDGE remains the desk/clinical surface bound", async () => {
  const { MAX_DECODE_EDGE } = await import("../src/lib/qr-decode-geometry.ts");
  assert.equal(MAX_DECODE_EDGE, 1200);
});
