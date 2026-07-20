import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import {
  isPatientUuid,
  parseRegistrationNumber,
  parsePatientIdFromQr,
  patientPrintUrl,
  patientScanUrl,
  resolveOrigin,
} from "../src/lib/qr.ts";

const VALID_UUID = "e3b0c442-98fc-41c4-a012-3456789abcde";
const VALID_UUID_UPPER = "E3B0C442-98FC-41C4-A012-3456789ABCDE";

test("isPatientUuid & resolveOrigin — helper validation", () => {
  assert.equal(isPatientUuid(VALID_UUID), true);
  assert.equal(isPatientUuid(VALID_UUID_UPPER), true);
  assert.equal(isPatientUuid("not-a-uuid"), false);

  assert.equal(resolveOrigin("https://camp.example/"), "https://camp.example");
  assert.equal(resolveOrigin("https://camp.example"), "https://camp.example");
  assert.equal(resolveOrigin(null), "");
});

test("parsePatientIdFromQr — exact scheme & UUID extraction", () => {
  // Bare UUIDs
  assert.equal(parsePatientIdFromQr(VALID_UUID), VALID_UUID);
  assert.equal(parsePatientIdFromQr(VALID_UUID_UPPER), VALID_UUID);
  assert.equal(parsePatientIdFromQr(`  ${VALID_UUID}  `), VALID_UUID);

  // Short path /p/<uuid>
  assert.equal(
    parsePatientIdFromQr(`https://snp-camps.org/p/${VALID_UUID}`),
    VALID_UUID
  );
  assert.equal(
    parsePatientIdFromQr(`http://localhost:3000/p/${VALID_UUID_UPPER}`),
    VALID_UUID
  );

  // Print path /print/<uuid>
  assert.equal(
    parsePatientIdFromQr(`https://snp-camps.org/print/${VALID_UUID}`),
    VALID_UUID
  );

  // Legacy enter path /patient/enter/<uuid>
  assert.equal(
    parsePatientIdFromQr(`https://snp-camps.org/patient/enter/${VALID_UUID}`),
    VALID_UUID
  );

  // Query parameters
  assert.equal(
    parsePatientIdFromQr(`https://snp-camps.org/scan?id=${VALID_UUID}`),
    VALID_UUID
  );
  assert.equal(
    parsePatientIdFromQr(`https://snp-camps.org/desk?scan=${VALID_UUID}`),
    VALID_UUID
  );
  assert.equal(
    parsePatientIdFromQr(`https://snp-camps.org/checkin?checkin=${VALID_UUID}`),
    VALID_UUID
  );

  // Compact snp: scheme
  assert.equal(parsePatientIdFromQr(`snp:${VALID_UUID}`), VALID_UUID);
  assert.equal(parsePatientIdFromQr(`SNP:${VALID_UUID_UPPER}`), VALID_UUID);
});

test("parsePatientIdFromQr — camera misread & boundary handling", () => {
  // Substring search in noisy camera string (<= 200 chars)
  const noisy = `SCANNED_PREFIX_${VALID_UUID}_SUFFIX_NOISE`;
  assert.equal(parsePatientIdFromQr(noisy), VALID_UUID);

  // Length > 200 chars containing UUID should reject fallback ANY_UUID_RE
  const longNoisy = "A".repeat(170) + VALID_UUID + "B".repeat(50); // total 256 chars
  assert.equal(parsePatientIdFromQr(longNoisy), null);

  // Malformed inputs & attacks
  assert.equal(parsePatientIdFromQr(""), null);
  assert.equal(parsePatientIdFromQr("   "), null);
  assert.equal(parsePatientIdFromQr("not-a-uuid"), null);
  assert.equal(parsePatientIdFromQr("javascript:alert('xss')"), null);
  assert.equal(parsePatientIdFromQr("e3b0c442-98fc-41c4-a012-3456789abcdg"), null); // invalid hex 'g'
  assert.equal(parsePatientIdFromQr("e3b0c44298fc41c4a0123456789abcde"), null); // missing hyphens
});

test("parseRegistrationNumber — boundary and overflow protection", () => {
  // Safe numbers
  assert.equal(parseRegistrationNumber(1), 1);
  assert.equal(parseRegistrationNumber("1001"), 1001);
  assert.equal(parseRegistrationNumber("Reg # 1001"), 1001);
  assert.equal(parseRegistrationNumber("00042"), 42);
  assert.equal(parseRegistrationNumber(2147483647), 2147483647); // REG_NO_MAX

  // Overflow / Out-of-range
  assert.equal(parseRegistrationNumber(2147483648), null);
  assert.equal(parseRegistrationNumber("2147483648"), null);
  assert.equal(parseRegistrationNumber(Number.MAX_SAFE_INTEGER + 1), null);
  assert.equal(parseRegistrationNumber(Infinity), null);

  // Invalid / Zero / Negative
  assert.equal(parseRegistrationNumber(0), null);
  assert.equal(parseRegistrationNumber(-10), null);
  assert.equal(parseRegistrationNumber("abc"), null);
  assert.equal(parseRegistrationNumber(null), null);
  assert.equal(parseRegistrationNumber(undefined), null);
});

test("patientScanUrl & patientPrintUrl — url generation format", () => {
  const origin = "https://camps.snp.org";
  assert.equal(
    patientScanUrl(VALID_UUID, origin),
    `https://camps.snp.org/p/${VALID_UUID}`
  );
  assert.equal(
    patientPrintUrl(VALID_UUID, origin),
    `https://camps.snp.org/print/${VALID_UUID}`
  );

  // Trailing slash origin normalization
  assert.equal(
    patientScanUrl(VALID_UUID, "https://camps.snp.org/"),
    `https://camps.snp.org/p/${VALID_UUID}`
  );

  // Non-UUID fallback
  assert.equal(patientScanUrl("invalid-id", origin), "invalid-id");
});

test("Empirical Latency & Benchmark — Zero-Delay Parsing Performance", () => {
  const sampleInputs = [
    VALID_UUID,
    `https://camps.snp.org/p/${VALID_UUID}`,
    `https://camps.snp.org/patient/enter/${VALID_UUID}?ref=qr`,
    `snp:${VALID_UUID}`,
    `https://camps.snp.org/scan?id=${VALID_UUID}`,
    "INVALID_QR_CODE_STRING_WITHOUT_UUID",
    "Reg #10015",
    "2147483647",
    "2147483649",
    `NOISY_PREFIX_${VALID_UUID}_SUFFIX`,
  ];

  const ITERATIONS = 100_000;
  const start = performance.now();

  for (let i = 0; i < ITERATIONS; i++) {
    const input = sampleInputs[i % sampleInputs.length];
    parsePatientIdFromQr(input);
    parseRegistrationNumber(input);
  }

  const durationMs = performance.now() - start;
  const avgMicrosecondsPerCall = (durationMs / (ITERATIONS * 2)) * 1000;

  console.log(
    `[BENCHMARK] Total time for ${ITERATIONS * 2} ops: ${durationMs.toFixed(
      2
    )} ms | Avg per call: ${avgMicrosecondsPerCall.toFixed(3)} µs`
  );

  // Zero-delay assertion: Average parsing time MUST be < 5 microseconds per call (0.005 ms)
  assert.ok(
    avgMicrosecondsPerCall < 5,
    `Parsing latency high: ${avgMicrosecondsPerCall.toFixed(3)} µs per call`
  );
});

test("ReDoS & Stress Test — Malformed long string input safety", () => {
  const adversarialInputs = [
    "a/".repeat(95),
    "?" + "id=".repeat(60),
    "snp:" + "123-".repeat(40),
    "/p/" + "0".repeat(190),
  ];

  const STRESS_ITERATIONS = 10_000;
  const start = performance.now();

  for (let i = 0; i < STRESS_ITERATIONS; i++) {
    for (const input of adversarialInputs) {
      parsePatientIdFromQr(input);
    }
  }

  const durationMs = performance.now() - start;
  console.log(
    `[STRESS TEST] ${STRESS_ITERATIONS * adversarialInputs.length} adversarial ops took: ${durationMs.toFixed(2)} ms`
  );

  // Must run under 250ms total for 40,000 adversarial parses (< 6.25 µs per call)
  assert.ok(
    durationMs < 250,
    `ReDoS risk detected! High execution time: ${durationMs.toFixed(2)} ms`
  );
});
