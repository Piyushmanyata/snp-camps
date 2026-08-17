import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desk = fs.readFileSync(
  path.join(root, "src", "components", "clinical-desk.tsx"),
  "utf8",
);

test("resolve refuses a missing OT day before setBusy(true)", () => {
  const start = desk.indexOf("async function resolve(");
  const end = desk.indexOf("function closeSlipReplace", start);
  assert.ok(start > 0 && end > start);
  const body = desk.slice(start, end);
  const guard = body.indexOf("needsOtScheduleDay(");
  const busy = body.indexOf("setBusy(true)");
  assert.ok(guard >= 0, "resolve must call needsOtScheduleDay");
  assert.ok(busy > guard, "setBusy(true) must follow the OT-day guard");
});
