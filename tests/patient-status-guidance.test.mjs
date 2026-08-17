import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("patient status guidance module is retired", () => {
  assert.equal(
    fs.existsSync(path.join(root, "src/lib/patient-status-guidance.ts")),
    false,
  );
});
