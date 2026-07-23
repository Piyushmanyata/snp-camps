import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const adminPage = fs.readFileSync(
  path.join(process.cwd(), "src/app/admin/page.tsx"),
  "utf8",
);
const qrEntryPage = fs.readFileSync(
  path.join(process.cwd(), "src/app/patient/enter/[id]/page.tsx"),
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
  assert.match(qrEntryPage, /if \(!isPatientUuid\(id\)\)/);
  assert.match(
    qrEntryPage,
    /if \(!isStaff\(profile\?\.role\)\)[\s\S]*\/patient\/qr-help/,
  );
  assert.match(qrEntryPage, /profile\?\.role === "admin"\s*\? "\/admin"/);
  assert.match(qrEntryPage, /profile\?\.role === "doctor"\s*\? "\/doctor"/);
  assert.match(qrEntryPage, /: "\/volunteer"/);
  assert.match(qrEntryPage, /`\$\{deskBase\}\?scan=\$\{id\}`/);
  assert.doesNotMatch(qrEntryPage, /lookup_patient_scan|createClient|\/print\//);
  // Relative redirect() keeps the current host/port (cookies stay bound).
  assert.match(qrEntryPage, /redirect\(`\$\{deskBase\}\?scan=\$\{id\}`\)/);
  assert.doesNotMatch(qrEntryPage, /NEXT_PUBLIC_SITE_URL/);
  assert.doesNotMatch(qrEntryPage, /req\.nextUrl|NextResponse\.redirect/);
});