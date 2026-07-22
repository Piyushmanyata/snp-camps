import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const source = (relativePath) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8").replace(/\r\n/g, "\n");

const patientForm = source("src/components/patient-form.tsx");
const scanner = source("src/components/qr-scanner.tsx");
const queue = source("src/components/live-queue.tsx");
const changeDay = source("src/components/change-day.tsx");
const campDays = source("src/components/admin-camp-days.tsx");
const camps = source("src/components/admin-camps.tsx");
const patientLogin = source("src/app/patient/login/page.tsx");
const volunteerPage = source("src/app/volunteer/page.tsx");
const staffDetail = source("src/components/staff-detail.tsx");
const doctorPage = source("src/app/doctor/page.tsx");
const ui = source("src/components/ui.tsx");

function functionSource(code, start, end) {
  const startAt = code.indexOf(start);
  const endAt = code.indexOf(end, startAt);
  assert.ok(startAt >= 0 && endAt > startAt, `${start} source must be present`);
  return code.slice(startAt, endAt);
}

test("registration fails closed when linking a verified phone errors", () => {
  const verify = functionSource(
    patientForm,
    "async function verifyOtp",
    "async function onSubmit",
  );
  const linkError = verify.indexOf("if (linkErr)");
  const formAdvance = verify.indexOf('setOtpStep("form")');

  assert.ok(linkError > verify.indexOf('"link_patient_phone"'));
  assert.ok(linkError < formAdvance);
  assert.match(
    verify.slice(linkError, formAdvance),
    /auth\.signOut\(\)[\s\S]*setOtpStep\("phone"\)[\s\S]*setError\([\s\S]*return;/,
  );
  assert.match(verify, /finally \{\s*setLoading\(false\)/);
});

test("patient OTP and desk registration recover from rejected network requests", () => {
  for (const [code, end] of [
    [patientForm, "async function onSubmit"],
    [patientLogin, "\n  return ("],
  ]) {
    const send = functionSource(code, "async function sendOtp", "async function verifyOtp");
    const verify = functionSource(code, "async function verifyOtp", end);
    assert.match(send, /try \{[\s\S]*catch \{[\s\S]*finally \{\s*setLoading\(false\)/);
    assert.match(verify, /try \{[\s\S]*catch \{[\s\S]*finally \{\s*setLoading\(false\)/);
  }
  const submit = functionSource(patientForm, "async function onSubmit", "function resetForm");
  assert.match(
    submit,
    /if \(isStaff\) \{[\s\S]*?try \{[\s\S]*?register_patient[\s\S]*?catch \{[\s\S]*?Registration service is unavailable/,
  );
});

test("patient form exposes field errors and focuses the first invalid control", () => {
  const submit = functionSource(
    patientForm,
    "async function onSubmit",
    "function resetForm",
  );

  assert.match(
    patientForm,
    /function failValidation[\s\S]*setFieldErrors\(\{ \[field\]: message \}\)[\s\S]*requestAnimationFrame\([\s\S]*\.focus\(\)/,
  );
  for (const [field, id] of [
    ["fullName", "patient-full-name"],
    ["phone", "patient-phone"],
    ["age", "patient-age"],
    ["address", "patient-address"],
    ["email", "patient-email"],
    ["aadhaar", "patient-aadhaar"],
  ]) {
    assert.match(patientForm, new RegExp(`id="${id}"[\\s\\S]*?error=\\{fieldErrors\\.${field}\\}`));
    assert.match(submit, new RegExp(`failValidation\\([\\s\\S]*?"${field}"[\\s\\S]*?"${id}"`));
  }
  assert.match(patientForm, /role="radiogroup"[\s\S]*aria-invalid=\{fieldErrors\.campDay/);
  assert.match(patientForm, /id="patient-camp-day-error"[\s\S]*fieldErrors\.campDay/);
  assert.match(patientForm, /<form[^>]*onSubmit=\{onSubmit\}[^>]*noValidate>/);
  assert.match(patientForm, /aria-expanded=\{showAadhaarLater\}/);
  assert.match(patientForm, /aria-controls=\{optionalDetailsId\}/);
  assert.match(patientForm, /id=\{optionalDetailsId\}/);
});

test("scanner review is announced and focused across every lookup entry path", () => {
  assert.match(
    scanner,
    /if \(!lookup\) return;[\s\S]*requestAnimationFrame\(\(\) => reviewRef\.current\?\.focus\(\)\)/,
  );
  assert.match(
    scanner,
    /ref=\{reviewRef\}[\s\S]*tabIndex=\{-1\}[\s\S]*role="region"[\s\S]*aria-live="polite"[\s\S]*aria-labelledby=\{reviewHeadingId\}/,
  );
  assert.match(scanner, /void resolvePatient\(\{ id \}\)/);
  assert.match(scanner, /await resolvePatient\(\{ regNo: reg \}\)/);
  const lookup = functionSource(
    scanner,
    "const resolvePatient = useCallback",
    "useEffect(() => {\n    if (!lookup)",
  );
  assert.match(lookup, /try \{[\s\S]*catch \{[\s\S]*Could not look up this patient/);
});

test("scanner, queue, and day mutations always release their busy state", () => {
  const scannerAssign = functionSource(
    scanner,
    "const assignDoctor = useCallback",
    "const resolvePatient = useCallback",
  );
  const queueAssign = functionSource(queue, "async function assign", "\n  return (");
  const dayChange = functionSource(changeDay, "async function onSubmit", "\n  return (");

  assert.match(scannerAssign, /finally \{\s*assigningRef\.current = false;\s*setAssigning\(false\)/);
  assert.match(queueAssign, /if \(busyId\) return;/);
  assert.match(queueAssign, /try \{[\s\S]*catch \{[\s\S]*finally \{\s*setBusyId\(null\)/);
  assert.match(dayChange, /try \{[\s\S]*catch \{[\s\S]*finally \{\s*setLoading\(false\)/);
});

test("camp-day errors stay with the affected form and saves always release busy state", () => {
  const addDay = functionSource(campDays, "async function addDay", "async function saveSeats");
  const saveSeats = functionSource(campDays, "async function saveSeats", "async function removeDay");

  assert.match(campDays, /dayError\?\.dayId === d\.id/);
  assert.match(campDays, /<ErrorBox message=\{addError\}/);
  assert.match(addDay, /try \{[\s\S]*catch \{[\s\S]*finally \{\s*setLoading\(false\)/);
  assert.match(saveSeats, /try \{[\s\S]*catch \{[\s\S]*finally \{\s*setSavingId\(null\)/);
});

test("camp management localizes errors and always releases mutation state", () => {
  const create = functionSource(camps, "async function createCamp", "async function activate");
  const activate = functionSource(camps, "async function activate", "async function removeCamp");
  const remove = functionSource(camps, "async function removeCamp", "\n  return (");

  assert.match(camps, /campError\?\.campId === c\.id/);
  assert.match(camps, /<ErrorBox message=\{createError\}/);
  assert.match(create, /try \{[\s\S]*catch \{[\s\S]*finally \{\s*setLoading\(false\)/);
  assert.match(activate, /try \{[\s\S]*catch \{[\s\S]*finally \{\s*setActivatingId\(null\)/);
  assert.match(remove, /try \{[\s\S]*catch \{[\s\S]*finally \{\s*setDeletingId\(null\)/);
});

test("queue only announces completion after refreshed props replace the source", () => {
  const manualRefresh = functionSource(queue, "function manualRefresh", "useFixedPoll");

  assert.match(queue, /refreshSource === initial\s*\? "Refreshing queue…"\s*:\s*"Queue updated"/);
  assert.match(manualRefresh, /setRefreshSource\(initial\);[\s\S]*refreshQueue\(\)/);
  assert.doesNotMatch(manualRefresh, /Queue updated/);
  assert.match(queue, /isPending \? "Refreshing…" : "Refresh"/);
});

test("patient login accurately describes passwordless reg number sign in", () => {
  assert.match(patientLogin, /Registration Number/);
  assert.match(patientLogin, /sign in directly/);
  assert.doesNotMatch(patientLogin, /type="password"/);
});

test("volunteer dashboard labels registration and check-in credit as handled", () => {
  assert.match(volunteerPage, /label="You handled"/);
  assert.match(volunteerPage, /label="Handled today"/);
  assert.doesNotMatch(volunteerPage, /label="You registered"/);
});

test("staff detail announces loading and labels volunteer activity consistently", () => {
  assert.match(staffDetail, /role="status"[\s\S]*Loading KPIs/);
  assert.match(staffDetail, /"Handled today"/);
  assert.match(staffDetail, /"Patients handled"/);
  assert.doesNotMatch(staffDetail, /"Patients registered"/);
});

test("admin doctor management keeps a mobile route back to admin", () => {
  const adminBranch = functionSource(doctorPage, "if (admin)", "const { data: camp");
  assert.match(
    adminBranch,
    /dock=\{\[[\s\S]*?href: "\/admin"[\s\S]*?href: "\/register"[\s\S]*?href: "\/admin\/patients"/,
  );
});

test("shared cards and long section hints cannot force mobile overflow", () => {
  assert.match(ui, /className=\{`min-w-0 rounded-xl border border-border bg-card/);
  assert.match(
    ui,
    /mb-3 flex min-w-0 flex-col[\s\S]*sm:flex-row[\s\S]*sm:text-right/,
  );
});

test("async page fallbacks expose loading status to assistive technology", () => {
  for (const file of [
    "src/app/admin/page.tsx",
    "src/app/volunteer/page.tsx",
    "src/app/doctor/page.tsx",
    "src/app/patient/page.tsx",
    "src/app/admin/patients/page.tsx",
    "src/app/print/[id]/page.tsx",
    "src/app/register/page.tsx",
  ]) {
    assert.doesNotMatch(
      source(file),
      /<p(?![^>]*role="status")[^>]*>\s*Loading(?:…|\.\.\.)?/,
      `${file} has an unannounced loading message`,
    );
  }
});
