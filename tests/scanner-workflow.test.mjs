import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { isSuccessfulAssignment } from "../src/lib/queue-assignment.ts";

const scanner = fs.readFileSync(
  path.join(process.cwd(), "src/components/qr-scanner.tsx"),
  "utf8",
);
const doctorPage = fs.readFileSync(
  path.join(process.cwd(), "src/app/doctor/page.tsx"),
  "utf8",
);
const doctorSeenSection = doctorPage.match(
  /async function DoctorSeenSection[\s\S]*?export default async function DoctorPage/,
)?.[0];
const liveQueue = fs.readFileSync(
  path.join(process.cwd(), "src/components/live-queue.tsx"),
  "utf8",
);

test("only a completed, error-free doctor assignment is successful", () => {
  const completed = {
    already_seen: false,
    doctor_id: "00000000-0000-4000-8000-000000000001",
    error_code: null,
    queue_status: "seen",
  };

  assert.equal(isSuccessfulAssignment(completed), true);
  assert.equal(
    isSuccessfulAssignment({ ...completed, error_code: "unexpected" }),
    false,
  );
  assert.equal(
    isSuccessfulAssignment({ ...completed, queue_status: "waiting" }),
    false,
  );
  assert.equal(isSuccessfulAssignment({ ...completed, doctor_id: null }), false);
  assert.equal(
    isSuccessfulAssignment({ ...completed, already_seen: true }),
    false,
  );
});

test("scanner and deep links look up before any explicit assignment", () => {
  const resolver = scanner.match(
    /const resolvePatient = useCallback\([\s\S]*?\/\/ Deep-link:/,
  )?.[0];

  assert.ok(resolver, "resolvePatient source must be present");
  assert.match(resolver, /rpc\("lookup_patient_scan"/);
  assert.doesNotMatch(resolver, /assignDoctor\(/);
  assert.match(scanner, /Confirm patient · mark seen/);
  assert.match(scanner, /if \(!isSuccessfulAssignment\(row\)\)/);
  assert.match(liveQueue, /if \(!row \|\| !isSuccessfulAssignment\(row\)\)/);
  assert.doesNotMatch(liveQueue, /mutationGeneration/);
  assert.doesNotMatch(scanner, /\/print\/\$\{lookup\.id\}\?auto=1/);
  assert.doesNotMatch(doctorPage, /\/print\//);
  assert.ok(doctorSeenSection, "doctor patient-history section must be present");
  assert.doesNotMatch(
    doctorSeenSection,
    /\.select\(["'][^"']*\bphone\b[^"']*["']\)/,
  );
});

test("deep-link scan strips query without App Router remount", () => {
  const deepLink = scanner.match(
    /\/\/ Deep-link:[\s\S]*?\}, \[resolvePatient\]\);/,
  )?.[0];
  assert.ok(deepLink, "deep-link effect must be present");
  assert.match(deepLink, /window\.history\.replaceState\(null, "", next\)/);
  assert.doesNotMatch(deepLink, /router\.replace\(/);
});
