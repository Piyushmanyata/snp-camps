import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("status page and rate-limit route are retired", () => {
  assert.equal(
    fs.existsSync(path.join(root, "src/app/s/[token]/page.tsx")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(root, "src/app/api/status-rate-limit/route.ts")),
    false,
  );
});
