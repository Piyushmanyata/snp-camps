import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const signOutPath = join(root, "src", "components", "sign-out.tsx");
const credentialsRoutePath = join(
  root,
  "src",
  "app",
  "api",
  "patient-credentials",
  "route.ts",
);

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(path)) ? [path] : [];
  });
}

test("logout signs out once and redirects only after Supabase succeeds", () => {
  const source = readFileSync(signOutPath, "utf8");
  const failureGuard = source.indexOf("if (signOutError)");
  const redirect = source.indexOf('router.replace("/")');

  assert.equal(source.match(/supabase\.auth\.signOut\(\)/g)?.length, 1);
  assert.ok(failureGuard >= 0 && redirect > failureGuard);
  assert.match(source.slice(failureGuard, redirect), /setError\([\s\S]*return;/);
  assert.match(source, /catch\s*\{[\s\S]*setError\(/);
});

test("logout never rotates or reveals patient credentials", () => {
  assert.equal(existsSync(credentialsRoutePath), false);

  const references = sourceFiles(join(root, "src")).filter((path) =>
    readFileSync(path, "utf8").includes("patient-credentials"),
  );

  assert.deepEqual(references, []);
  assert.doesNotMatch(
    readFileSync(signOutPath, "utf8"),
    /patientMode|password|credentials|navigator\.clipboard|fetch\(/i,
  );
});
