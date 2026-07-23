import { performance } from "node:perf_hooks";
import { parsePatientIdFromQr, parseRegistrationNumber } from "../src/lib/qr.ts";
import { isValidAadhaarNumber } from "../src/lib/aadhaar.ts";
import { normalizePhoneE164 } from "../src/lib/phone.ts";



const payloads = {
  p1: "/p/" + "a".repeat(10_000),
  p2: "/print/" + "b".repeat(10_000),
  p3: "/patient/enter/" + "c".repeat(10_000),
  p4: "?" + "id=".repeat(5_000),
  p5: "?" + "scan=".repeat(5_000),
  p6: "?" + "checkin=".repeat(5_000),
  p7: "snp:" + "12345678-".repeat(1_000),
  p8: "SNP:" + "ABCDEFGH-".repeat(1_000),
  p9: "A".repeat(100_000),
  p10: "9".repeat(100_000),
  p11: "e3b0c442-98fc-41c4-a012-" + "3".repeat(50_000),
  p12: "00000000-0000-0000-0000-".repeat(500) + "000000000000",
  p13: "9".repeat(100_000) + "X",
  p14: "+91" + "9".repeat(100_000),
};

const parsers = {
  parsePatientIdFromQr,
  parseRegistrationNumber,
  isValidAadhaarNumber,
  normalizePhoneE164
};

console.log("--- ISOLATION BENCHMARK (100 ops each) ---");
for (const [pName, payload] of Object.entries(payloads)) {
  for (const [fnName, fn] of Object.entries(parsers)) {
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      fn(payload);
    }
    const ms = performance.now() - start;
    if (ms > 5) {
      console.log(`[SLOW] ${fnName} on ${pName} (${payload.length} chars, sample: ${payload.slice(0,30)}...): ${ms.toFixed(2)} ms for 100 ops (${(ms/100*1000).toFixed(2)} µs/op)`);
    }
  }
}
