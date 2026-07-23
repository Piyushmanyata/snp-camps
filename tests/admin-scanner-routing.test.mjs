import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const adminPage = fs.readFileSync(
  path.join(process.cwd(), "src/app/admin/page.tsx"),
  "utf8",
);
const qrEntryRoute = fs.readFileSync(
  path.join(process.cwd(), "src/app/patient/enter/[id]/route.ts"),
  "utf8",
);

test("admin dashboard shares active doctors between scanner and queue", () => {
  assert.match(adminPage, /import\("@\/components\/qr-scanner"\)/);
  assert.match(adminPage, /<Card id="scan"/);
  assert.match(adminPage, /<QrScanner mode="admin" doctors=\{doctors\} \/>/);
  assert.match(adminPage, /href: "#scan", label: "Scan", primary: true/);
  assert.equal(adminPage.match(/getDoctorsList\(\)/g)?.length, 1);
});

test("staff QR GET routes to each role's lookup-first scanner", () => {
  assert.match(qrEntryRoute, /if \(!isPatientUuid\(id\)\)/);
  assert.match(
    qrEntryRoute,
    /if \(!isStaff\(profile\?\.role\)\)[\s\S]*\/patient\/qr-help/,
  );
  assert.match(qrEntryRoute, /profile\?\.role === "admin"\s*\? "\/admin"/);
  assert.match(qrEntryRoute, /profile\?\.role === "doctor"\s*\? "\/doctor"/);
  assert.match(qrEntryRoute, /: "\/volunteer"/);
  assert.match(qrEntryRoute, /`\$\{deskBase\}\?scan=\$\{id\}`/);
  assert.doesNotMatch(qrEntryRoute, /lookup_patient_scan|createClient|\/print\//);
  // Desk handoff must clone the request URL so host/port (and cookies) match.
  assert.match(qrEntryRoute, /req\.nextUrl\.clone\(\)/);
  assert.doesNotMatch(qrEntryRoute, /NEXT_PUBLIC_SITE_URL/);
});
