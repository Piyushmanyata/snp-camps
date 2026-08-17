import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REQUIRED_COLUMNS, REQUIRED_FUNCTIONS } from "../src/lib/readiness-contract.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("status page, lookup, and token modules are gone", () => {
  assert.equal(fs.existsSync(path.join(root, "src/app/s/[token]/page.tsx")), false);
  assert.equal(fs.existsSync(path.join(root, "src/app/lookup/page.tsx")), false);
  assert.equal(fs.existsSync(path.join(root, "src/app/api/lookup/route.ts")), false);
  assert.equal(
    fs.existsSync(path.join(root, "src/app/api/status-rate-limit/route.ts")),
    false,
  );
  assert.equal(fs.existsSync(path.join(root, "src/lib/status-token.ts")), false);
  assert.ok(!REQUIRED_COLUMNS.patients.includes("status_token"));
  assert.ok(!REQUIRED_FUNCTIONS.includes("patient_status_by_token"));
});
