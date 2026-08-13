import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("retired theatre capacity is absent from active camp-day administration", () => {
  const campDays = source("src/components/admin-camp-days.tsx");
  const types = source("src/lib/types.ts");

  assert.doesNotMatch(campDays, /theatre|p_theatre_capacity/i);
  assert.doesNotMatch(types, /theatre_(?:capacity|reserved|remaining)/i);
});

test("admin patient filtering never queries the dropped prescriptions table", () => {
  const patients = source("src/components/admin-patients.tsx");

  assert.doesNotMatch(patients, /prescriptions\s*\(/i);
});

test("admin test-SMS and registration print-mode surfaces are retired", () => {
  const adminPage = source("src/app/admin/page.tsx");
  const optional = source("src/components/admin-optional-lazy.tsx");
  const settings = source("src/components/admin-settings-panel.tsx");
  const settingsClient = source("src/lib/admin-settings.ts");

  assert.doesNotMatch(adminPage, /AdminTestSms/i);
  assert.doesNotMatch(optional, /AdminTestSms|Registration SMS \(MSG91\)/i);
  assert.doesNotMatch(settings, /print mode|paperFallback|Desk Slip/i);
  assert.doesNotMatch(settingsClient, /paperFallback|paper_fallback_mode/i);
  assert.equal(
    existsSync(
      new URL("../src/app/api/admin/test-sms/route.ts", import.meta.url),
    ),
    false,
  );
  assert.equal(
    existsSync(new URL("../src/components/admin-test-sms.tsx", import.meta.url)),
    false,
  );
});

test("doctor is not an accepted staff-management role", () => {
  const staffRoute = source("src/app/api/admin/staff/[role]/route.ts");
  const adminStaff = source("src/components/admin-staff.tsx");
  const staffDetail = source("src/components/staff-detail.tsx");

  assert.doesNotMatch(staffRoute, /["']doctor["']/);
  assert.doesNotMatch(adminStaff, /["']doctor["']/);
  assert.doesNotMatch(staffDetail, /["']doctor["']/);
});
