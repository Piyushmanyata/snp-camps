import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

test("staff detail batches independent database reads", () => {
  const code = source("src/app/api/admin/staff-detail/route.ts");
  assert.ok(
    (code.match(/await Promise\.all\(/g)?.length ?? 0) >= 2,
    "profile/camp and KPI/patient reads should each share a round trip",
  );
  assert.match(code, /campError \|\| pErr/);
  assert.match(code, /\.or\(`created_by\.eq\.\$\{id\},checked_in_by\.eq\.\$\{id\}`\)/);
  assert.match(code, /Patients handled/);
});

test("patient search cancels stale requests and keeps its projection lean", () => {
  const code = source("src/components/admin-patients.tsx");
  const select = code.slice(code.indexOf("const SELECT"), code.indexOf("export function"));

  assert.ok(code.includes("query.abortSignal(controller.signal)"));
  assert.ok(code.includes("controller.abort()"));
  assert.match(code, /catch \{[\s\S]*controller\.signal\.aborted[\s\S]*finally \{/);
  assert.match(
    code,
    /async function removePatient[\s\S]*if \((?:deletingId|mutationBusy)\) return;[\s\S]*try \{[\s\S]*catch \{[\s\S]*finally \{\s*setDeletingId\(null\)/,
  );
  assert.ok(code.includes("const TIMESTAMP_FORMATTER"));
  assert.ok(!code.includes("firstQuery"), "the default server snapshot must not refetch");
  assert.ok(code.includes("if (isDefaultView) return"));
  assert.match(
    code,
    /isDefaultView[\s\S]*?No patients registered yet\.[\s\S]*?No patients match your search or filter\./,
  );
  assert.ok(!select.includes("camp_day_id"), "unused camp_day_id must not be transferred");
});

test("patient desk does not disguise active-camp database failures as an empty camp", () => {
  const code = source("src/app/admin/patients/page.tsx");
  assert.match(code, /data: camp, error: campError/);
  assert.match(code, /if \(campError \|\| patientsRes\.error/);
});

test("load harness streams response bodies and reports measured throughput", () => {
  const code = source("scripts/load-test.mjs");

  assert.ok(code.includes("response.body.pipeTo(new WritableStream())"));
  assert.ok(code.includes("requests / elapsedSeconds"));
  assert.ok(code.includes("Math.ceil(latencies.length * value) - 1"));
  assert.ok(code.includes("Math.min(remainingMs"));
});
