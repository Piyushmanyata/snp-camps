import assert from "node:assert/strict";
import test from "node:test";

import {
  canRegisterPatients,
  isCampCrew,
  isClinicalOperator,
  isStaff,
  roleHome,
} from "../src/lib/roles.ts";
import { validateHouseholdPhone } from "../src/lib/phone.ts";
import { encodeCsvCell } from "../src/lib/clinical-csv.ts";

test("clinical operator is a login role but never registration camp crew", () => {
  assert.equal(isClinicalOperator("clinical_operator"), true);
  assert.equal(isCampCrew("clinical_operator"), false);
  assert.equal(isStaff("clinical_operator"), false);
  assert.equal(canRegisterPatients("clinical_operator"), false);
  assert.equal(roleHome("clinical_operator"), "/clinical");
});

test("household phone is mandatory, Indian-mobile shaped, and rejects dummy digits", () => {
  assert.deepEqual(validateHouseholdPhone("98765 43210"), {
    ok: true,
    phone: "9876543210",
  });
  for (const value of ["", "12345", "1234567890", "9999999999"]) {
    assert.equal(validateHouseholdPhone(value).ok, false, value);
  }
});

test("clinical CSV export neutralizes spreadsheet formula prefixes", () => {
  assert.equal(encodeCsvCell('=HYPERLINK("bad")'), '"\'=HYPERLINK(""bad"")"');
  assert.equal(encodeCsvCell("+1+1"), "\"'+1+1\"");
  assert.equal(encodeCsvCell("-2+3"), "\"'-2+3\"");
  assert.equal(encodeCsvCell("@SUM(A1:A2)"), "\"'@SUM(A1:A2)\"");
  assert.equal(encodeCsvCell("\t=1+1"), "\"'\t=1+1\"");
  assert.equal(encodeCsvCell("Normal name"), "\"Normal name\"");
});

test("patient QR scan dispatch maps clinical_operator to /clinical and admin to admin desk", () => {
  const patientId = "a0b1c2d3-e4f5-4678-9abc-def012345678";
  function dispatchPatientScan(role) {
    if (isClinicalOperator(role)) {
      return `/clinical?scan=${patientId}`;
    }
    if (!isCampCrew(role)) {
      return null;
    }
    const deskBase = roleHome(role) || "/volunteer";
    return `${deskBase}?scan=${patientId}`;
  }

  assert.equal(dispatchPatientScan("clinical_operator"), `/clinical?scan=${patientId}`);
  assert.equal(dispatchPatientScan("admin"), `/admin?scan=${patientId}`);
  assert.equal(dispatchPatientScan("volunteer"), `/volunteer?scan=${patientId}`);
  assert.equal(dispatchPatientScan("team_lead"), `/volunteer?scan=${patientId}`);
  assert.equal(dispatchPatientScan("patient"), null);
  assert.equal(dispatchPatientScan(null), null);
});

