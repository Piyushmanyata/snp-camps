/**
 * Ticket #94 — A4 Prescription Print Route & Component Behavioral Test Suite.
 * Tests header block data, empty section ruled lines for handwriting,
 * clinical body text rendering, staff-only access control, and A4 print layout geometry.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCampCrew, isStaff, isDoctor } from "../src/lib/roles.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readComponent() {
  const componentPath = path.join(
    root,
    "src",
    "components",
    "prescription-print-sheet.tsx",
  );
  return fs.readFileSync(componentPath, "utf8");
}

function readRoute() {
  const routePath = path.join(
    root,
    "src",
    "app",
    "print",
    "prescription",
    "[id]",
    "page.tsx",
  );
  return fs.readFileSync(routePath, "utf8");
}

function readPrintCss() {
  const cssPath = path.join(root, "src", "app", "print", "print.css");
  return fs.readFileSync(cssPath, "utf8");
}

test("Access Control Invariants: Staff (admin, volunteer, doctor) allowed; unauthenticated & patient status denied", () => {
  // Authorized camp crew roles
  assert.equal(isCampCrew("admin"), true, "Admin is authorized camp crew");
  assert.equal(isCampCrew("volunteer"), true, "Volunteer is authorized camp crew");
  assert.equal(isCampCrew("doctor"), true, "Doctor is authorized camp crew");

  // Refused non-staff / unauthenticated / patient status token requests
  assert.equal(isCampCrew("patient"), false, "Patient role must be refused");
  assert.equal(isCampCrew(null), false, "Unauthenticated (null role) must be refused");
  assert.equal(isCampCrew(undefined), false, "Unauthenticated (undefined role) must be refused");
  assert.equal(isCampCrew("anonymous"), false, "Arbitrary non-staff role must be refused");
});

test("Route access control enforces staff check and redirects non-staff or unauthenticated to /login", () => {
  const routeSrc = readRoute();
  assert.match(routeSrc, /getSessionProfile/);
  assert.match(routeSrc, /isCampCrew/);
  assert.match(routeSrc, /if\s*\(!profile\s*|\|\s*!isCampCrew\(profile\.role\)\)/);
  assert.match(routeSrc, /redirect\s*\(\s*["']\/login["']\s*\)/);
});

test("Route queries patients and prescriptions from Supabase for patient ID", () => {
  const routeSrc = readRoute();
  assert.match(routeSrc, /\.from\s*\(\s*["']patients["']\s*\)/);
  assert.match(routeSrc, /id,\s*reg_no,\s*full_name,\s*age,\s*gender/);
  assert.match(routeSrc, /\.from\s*\(\s*["']prescriptions["']\s*\)/);
  assert.match(routeSrc, /diagnosis,\s*examination,\s*medicines,\s*advice/);
  assert.match(routeSrc, /patientScanUrl/);
});

test("PrescriptionPrintSheet renders complete header block with patient & camp metadata and staff-scan QR code", () => {
  const componentSrc = readComponent();

  // Header Block Patient fields
  assert.match(componentSrc, /data-testid=["']prescription-header["']/);
  assert.match(componentSrc, /data-testid=["']patient-reg-no["']/);
  assert.match(componentSrc, /data-testid=["']patient-name["']/);
  assert.match(componentSrc, /data-testid=["']patient-age-gender["']/);
  assert.match(componentSrc, /data-testid=["']patient-camp-meta["']/);

  // Staff-scan QR code integration
  assert.match(componentSrc, /data-testid=["']patient-qr-code["']/);
  assert.match(componentSrc, /<QrCode/);
  assert.match(componentSrc, /Staff Scan/);
});

test("PrescriptionPrintSheet renders empty clinical sections with ruled blank lines for handwriting", () => {
  const componentSrc = readComponent();

  // Clinical Body sections
  assert.match(componentSrc, /Diagnosis/);
  assert.match(componentSrc, /Examination/);
  assert.match(componentSrc, /Medicines/);
  assert.match(componentSrc, /Advice/);

  // Ruled blank lines for handwriting in empty sections
  assert.match(componentSrc, /data-testid=["']ruled-lines["']/);
  assert.match(componentSrc, /ruled-lines/);
  assert.match(componentSrc, /data-section=\{key\}/);
  assert.match(componentSrc, /border-b border-slate-300 h-7/);
});

test("PrescriptionPrintSheet renders on-demand print button and A4 print layout attributes", () => {
  const componentSrc = readComponent();
  const cssSrc = readPrintCss();

  // On-demand print button
  assert.match(componentSrc, /data-testid=["']print-prescription-button["']/);
  assert.match(componentSrc, /Print Prescription \(A4\)/);
  assert.match(componentSrc, /window\.print\(\)/);

  // A4 Geometry Layout
  assert.match(componentSrc, /prescription-a4/);
  assert.match(componentSrc, /data-print-format=["']a4-prescription["']/);

  // CSS A4 page definition
  assert.match(cssSrc, /@page prescription-a4/);
  assert.match(cssSrc, /size:\s*A4/);
  assert.match(cssSrc, /margin:\s*15mm/);
});
