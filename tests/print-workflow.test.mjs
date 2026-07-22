import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (relativePath) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

test("print page GET is read-only and limited to registration staff", () => {
  const page = read("src/app/print/[id]/page.tsx");

  assert.ok(page.includes("canRegisterPatients(profile.role)"));
  assert.ok(page.includes("patientId={patient.id}"));
  assert.ok(page.includes("queueStatus={patient.queue_status}"));
  assert.ok(page.includes('profile.role === "admin" ? "/admin" : "/volunteer"'));
  assert.doesNotMatch(page, /mark_patient_printed|\.rpc\s*\(/);
  assert.doesNotMatch(page, /autoPrint|searchParams|initiallyQueued/);
});

test("print mutation is an authenticated no-store POST with idempotent output", () => {
  const route = read("src/app/api/patients/[id]/print/route.ts");

  assert.ok(route.includes("export async function POST"));
  assert.ok(route.includes("getSessionProfile()"));
  assert.ok(route.includes("canRegisterPatients(profile?.role)"));
  assert.ok(route.includes("isPatientUuid(id)"));
  assert.ok(route.includes('"Cache-Control": "no-store, max-age=0"'));
  assert.ok(route.includes('rpc("mark_patient_printed"'));
  assert.ok(route.includes("result.already_printed"));
  assert.doesNotMatch(route, /isStaff\s*\(/);
});

test("print action mutates first and opens the dialog only after success", () => {
  const actions = read("src/components/print-actions.tsx");
  const fetchIndex = actions.indexOf("await fetch(");
  const successCheckIndex = actions.indexOf("if (!response.ok || !payload.ok)");
  const printIndex = actions.indexOf("window.print()");

  assert.ok(fetchIndex >= 0);
  assert.ok(successCheckIndex > fetchIndex);
  assert.ok(printIndex > successCheckIndex);
  assert.ok(actions.includes('method: "POST"'));
  assert.ok(actions.includes("disabled={isPrinting}"));
  assert.ok(actions.includes('role={message.tone === "error" ? "alert" : "status"}'));
  assert.ok(actions.includes('queueStatus === "waiting"'));
  assert.ok(actions.includes('queueStatus === "seen"'));
  assert.ok(actions.includes("Print completed form"));
  assert.ok(actions.includes("href={deskHref}"));
  assert.doesNotMatch(actions, /href="\/volunteer"/);
  assert.doesNotMatch(actions, /useEffect|setTimeout|autoPrint|initiallyQueued/);
});

test("print sheet shows camp day and a human-readable gender", () => {
  const page = read("src/app/print/[id]/page.tsx");
  const sheet = read("src/components/print-sheet.tsx");

  assert.match(page, /camp_days\(day_date\)/);
  assert.match(page, /campDayDate=\{campDayDate\}/);
  assert.match(sheet, /const selectedDay = campDayDate \|\| camp\?\.camp_date/);
  assert.ok(sheet.includes('M: "Male"'));
  assert.ok(sheet.includes('F: "Female"'));
  assert.ok(sheet.includes('O: "Other"'));
  assert.ok(sheet.includes(">Camp day</"));
  assert.ok(sheet.includes(">Gender</"));
});
