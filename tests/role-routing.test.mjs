import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (relativePath) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

test("authenticated users have one stable role home", () => {
  const auth = read("src/lib/auth.ts");

  assert.match(auth, /role === "admin"\) return "\/admin"/);
  assert.match(auth, /role === "volunteer"\) return "\/volunteer"/);
  assert.match(auth, /role === "doctor"\) return "\/doctor"/);
  assert.match(auth, /role === "patient"\) return "\/patient"/);
});

test("wrong-role server pages redirect to the authenticated user's home", () => {
  for (const page of [
    "src/app/admin/page.tsx",
    "src/app/doctor/page.tsx",
    "src/app/volunteer/page.tsx",
    "src/app/patient/page.tsx",
  ]) {
    assert.match(
      read(page),
      /roleHome\(profile\?\.role\)/,
      `${page} must use the shared role-home redirect`,
    );
  }

  const patient = read("src/app/patient/page.tsx");
  assert.doesNotMatch(patient, /Open print form/);
});
