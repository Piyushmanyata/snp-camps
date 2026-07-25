import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  budgetFromMeasured,
  checkBudgets,
  formatReport,
  loadBudgets,
  main,
} from "../scripts/check-js-budget.mjs";

test("checkBudgets fails when a route exceeds its gzipped budget", () => {
  const result = checkBudgets(
    [{ route: "/volunteer", raw: 1_750_000, gzip: 510_000 }],
    { "/volunteer": 400_000 },
  );

  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  const f = result.failures[0];
  assert.equal(f.route, "/volunteer");
  assert.equal(f.budget, 400_000);
  assert.equal(f.actual, 510_000);
  assert.equal(f.overage, 110_000);
  assert.match(f.message, /\/volunteer/);
  assert.match(f.message, /budget=400000/);
  assert.match(f.message, /actual=510000/);
  assert.match(f.message, /overage=110000/);
});

test("checkBudgets fails when a measured route has no budget entry", () => {
  const result = checkBudgets(
    [{ route: "/doctor", raw: 100, gzip: 50 }],
    { "/volunteer": 999_999 },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.missingBudgets, ["/doctor"]);
  assert.match(formatReport(result), /budget missing: \/doctor/);
});

test("checkBudgets passes when every route is within budget", () => {
  const result = checkBudgets(
    [
      { route: "/login", raw: 900_000, gzip: 265_000 },
      { route: "/volunteer", raw: 1_750_000, gzip: 510_000 },
    ],
    { "/login": 270_000, "/volunteer": 520_000 },
  );

  assert.equal(result.ok, true);
  assert.equal(result.failures.length, 0);
  assert.equal(result.missingBudgets.length, 0);
});

test("budgetFromMeasured rounds up slightly above the measurement", () => {
  assert.equal(budgetFromMeasured(100_000), 103_000);
  assert.ok(budgetFromMeasured(509_439) > 509_439);
});

test("loadBudgets accepts flat map or { routes } wrapper", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "js-budget-"));
  const flat = path.join(dir, "flat.json");
  const wrapped = path.join(dir, "wrapped.json");
  fs.writeFileSync(flat, JSON.stringify({ "/a": 1 }));
  fs.writeFileSync(wrapped, JSON.stringify({ routes: { "/a": 2 } }));
  assert.deepEqual(loadBudgets(flat), { "/a": 1 });
  assert.deepEqual(loadBudgets(wrapped), { "/a": 2 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("main exits non-zero when budgets are deliberately too low", () => {
  const nextDir = path.join(process.cwd(), ".next");
  if (!fs.existsSync(path.join(nextDir, "build-manifest.json"))) {
    // Unit path above still covers the failure logic; skip integration without a build.
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "js-budget-cli-"));
  const budgetsPath = path.join(dir, "budgets.json");
  // Every route over budget — proves the CLI failure path end-to-end.
  fs.writeFileSync(budgetsPath, JSON.stringify({ "/": 1 }));

  const lines = [];
  const code = main(
    ["--budgets", budgetsPath, "--next-dir", nextDir],
    {
      cwd: process.cwd(),
      log: (s) => lines.push(String(s)),
      error: (s) => lines.push(String(s)),
    },
  );

  assert.equal(code, 1);
  const joined = lines.join("\n");
  assert.match(joined, /JS budget exceeded|JS budget missing/);
  fs.rmSync(dir, { recursive: true, force: true });
});
