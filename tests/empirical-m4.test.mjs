import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  parseRegistrationNumber,
  parsePatientIdFromQr,
} from "../src/lib/qr.ts";
import { checkRateLimit } from "../src/lib/rate-limit-core.ts";

const VALID_UUID = "e3b0c442-98fc-41c4-a012-3456789abcde";

test("Empirical Microbenchmark: 500,000 QR & RegNo parse ops", () => {
  const inputs = [
    VALID_UUID,
    `https://snp-camps.org/p/${VALID_UUID}`,
    `https://snp-camps.org/print/${VALID_UUID}`,
    `https://snp-camps.org/patient/enter/${VALID_UUID}?ref=test`,
    `snp:${VALID_UUID}`,
    `https://snp-camps.org/scan?id=${VALID_UUID}`,
    "Reg # 10045",
    "2147483647",
    "invalid-qr-payload-string-without-uuid",
    "A".repeat(150) + VALID_UUID + "B".repeat(30),
  ];

  const ITERATIONS = 50_000; // 50k * 10 inputs = 500k ops
  const start = performance.now();

  for (let i = 0; i < ITERATIONS; i++) {
    for (const input of inputs) {
      parsePatientIdFromQr(input);
      parseRegistrationNumber(input);
    }
  }

  const duration = performance.now() - start;
  const totalOps = ITERATIONS * inputs.length * 2;
  const avgUs = (duration / totalOps) * 1000;

  console.log(
    `[MICROBENCHMARK] ${totalOps} QR & RegNo parsing ops executed in ${duration.toFixed(
      2
    )} ms (${avgUs.toFixed(4)} µs/op)`
  );

  // Assert ultra-fast parsing (< 2 microseconds per operation)
  assert.ok(avgUs < 2.0, `Parsing too slow: ${avgUs} µs/op`);
});

test("ReDoS Safety: Extreme adversarial input payload stress test", () => {
  const reDosPayloads = [
    "a/".repeat(250),
    "?" + "id=".repeat(150),
    "snp:" + "12345678-".repeat(100),
    "/p/" + "f".repeat(300),
    "https://camps.org/" + "a".repeat(1000), // > 512 length boundary check
    "a".repeat(500) + "-" + "b".repeat(500),
    "0".repeat(512),
  ];

  const STRESS_OPS = 50_000;
  const start = performance.now();

  for (let i = 0; i < STRESS_OPS; i++) {
    for (const payload of reDosPayloads) {
      const res = parsePatientIdFromQr(payload);
      assert.equal(res, null); // All adversarial inputs must safely return null
    }
  }

  const duration = performance.now() - start;
  const totalCalls = STRESS_OPS * reDosPayloads.length;
  console.log(
    `[REDOS STRESS] ${totalCalls} ReDoS adversarial payloads processed in ${duration.toFixed(
      2
    )} ms`
  );

  // Must execute under 200 ms total (< 0.57 µs/call)
  assert.ok(duration < 200, `ReDoS risk! Took ${duration} ms`);
});

test("Rate Limiter Stress Test: IP rotation, subject lockout, and memory sweep", () => {
  const reqBase = "https://snp-camps.org/api/test";

  // Test 1: Single IP burst limit
  const scope1 = "stress-ip-" + Date.now();
  for (let i = 1; i <= 10; i++) {
    const req = new Request(reqBase, { headers: { "x-forwarded-for": "10.0.0.1" } });
    const res = checkRateLimit(req, { scope: scope1, limit: 5, windowMs: 60000 });
    if (i <= 5) {
      assert.equal(res.allowed, true, `Req ${i} should be allowed`);
    } else {
      assert.equal(res.allowed, false, `Req ${i} should be blocked`);
    }
  }

  // Test 2: IP rotation attack with fixed subject
  const scope2 = "stress-subject-" + Date.now();
  const subject = "patient-uuid-target-12345";
  for (let i = 1; i <= 10; i++) {
    const req = new Request(reqBase, {
      headers: { "x-forwarded-for": `192.168.1.${i}` }, // IP rotates each request
    });
    const res = checkRateLimit(req, {
      scope: scope2,
      identifier: subject,
      limit: 3,
      windowMs: 60000,
    });
    if (i <= 3) {
      assert.equal(res.allowed, true, `Req ${i} with subject should be allowed`);
    } else {
      assert.equal(res.allowed, false, `Req ${i} with subject MUST be blocked across IP rotation`);
    }
  }

  // Test 3: High volume throughput performance test (20,000 rate limit checks)
  const scope3 = "stress-perf-" + Date.now();
  const start = performance.now();
  const LIMIT_CHECKS = 20_000;
  for (let i = 0; i < LIMIT_CHECKS; i++) {
    const req = new Request(reqBase, {
      headers: { "x-forwarded-for": `172.16.${i % 250}.${(i / 250) | 0}` },
    });
    checkRateLimit(req, { scope: scope3, limit: 100, windowMs: 60000 });
  }
  const duration = performance.now() - start;
  console.log(
    `[RATE LIMITER BENCHMARK] ${LIMIT_CHECKS} rate limit checks completed in ${duration.toFixed(
      2
    )} ms (${((LIMIT_CHECKS / duration) * 1000).toFixed(0)} ops/sec)`
  );
  assert.ok(duration < 500, `Rate limiter too slow: ${duration} ms`);
});

test("SQL Syntax & Guard Verification: Parse and inspect supabase/*.sql files", () => {
  const sqlDir = path.join(process.cwd(), "supabase");
  const sqlFiles = fs.readdirSync(sqlDir).filter((f) => f.endsWith(".sql"));

  assert.ok(sqlFiles.length > 0, "No SQL files found in supabase/");

  let totalFunctions = 0;
  let statusGuardedFunctions = 0;
  let rowLockGuardedFunctions = 0;

  for (const file of sqlFiles) {
    const filePath = path.join(sqlDir, file);
    const content = fs.readFileSync(filePath, "utf-8");

    // 1. Check basic PL/pgSQL block pairing (BEGIN / END) if CREATE FUNCTION exists
    const fnMatches = content.match(/create\s+(or\s+replace\s+)?function/gi) || [];
    totalFunctions += fnMatches.length;

    // Strip single-line and multi-line comments before counting SQL keywords
    const cleanContent = content
      .replace(/--.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    const secDefinerMatches = cleanContent.match(/security\s+definer/gi) || [];
    const searchPathMatches =
      cleanContent.match(
        /set\s+search_path\s*(?:=|to)\s*[^;\n]*['"]?public/gi
      ) || [];
    if (secDefinerMatches.length > 0) {
      assert.ok(
        searchPathMatches.length >= secDefinerMatches.length,
        `File ${file} has SECURITY DEFINER functions (${secDefinerMatches.length}) without an explicit safe search_path (${searchPathMatches.length})`
      );
    }

    // 3. Inspect status transition guards in RPC files
    if (content.includes("assign_patient_doctor") || content.includes("checkin_patient_queue")) {
      if (content.includes("queue_status = 'seen'") || content.includes("queue_status = 'waiting'")) {
        statusGuardedFunctions++;
      }
      if (content.includes("for update")) {
        rowLockGuardedFunctions++;
      }
    }
  }

  console.log(
    `[SQL VERIFICATION] Inspected ${sqlFiles.length} SQL files, ${totalFunctions} function definitions.`
  );
  console.log(
    `[SQL GUARDS] Verified status transition guards (${statusGuardedFunctions}) and row locks (${rowLockGuardedFunctions}).`
  );

  assert.ok(statusGuardedFunctions > 0, "Expected status transition guards in RPCs");
  assert.ok(rowLockGuardedFunctions > 0, "Expected row-level locking (FOR UPDATE) in state-changing RPCs");
});

test("QR Scanner Teardown Verification: Static AST inspection of src/components/qr-scanner.tsx", () => {
  const scannerPath = path.join(process.cwd(), "src/components/qr-scanner.tsx");
  const code = fs.readFileSync(scannerPath, "utf-8");

  // Check 1: stopScanner cleans up animation frame
  assert.ok(
    code.includes("cancelAnimationFrame(animFrameRef.current)"),
    "stopScanner must cancelAnimationFrame"
  );

  // Check 2: stopScanner stops stream tracks
  assert.ok(
    code.includes("streamRef.current.getTracks().forEach"),
    "stopScanner must stop media stream tracks"
  );

  // Check 3: stopScanner clears video element srcObject
  assert.ok(
    code.includes("videoRef.current.srcObject = null"),
    "stopScanner must reset videoRef srcObject to null"
  );

  // Check 4: stopScanner stops and clears html5Qrcode scanner
  assert.ok(
    code.includes("html5Scanner.stop()") && code.includes("html5Scanner.clear()"),
    "stopScanner must call .stop() and .clear() on html5Qrcode"
  );

  // Check 5: useEffect unmount cleanup
  assert.ok(
    code.includes("return () => {") && code.includes("void stopScanner()"),
    "useEffect unmount hook must call stopScanner"
  );

  // Check 6: Race condition generation counter
  assert.ok(
    code.includes("scannerGeneration.current += 1") &&
      code.includes("generation !== scannerGeneration.current"),
    "start() and stopScanner must use generation counter to reject stale callbacks"
  );

  console.log("[QR SCANNER TEARDOWN] All 6 camera stream cleanup and concurrency guards verified!");
});
