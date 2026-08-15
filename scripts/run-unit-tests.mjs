import fs from "node:fs";
import { spawnSync } from "node:child_process";

const files = fs
  .readdirSync("tests")
  .filter(
    (name) => name.endsWith(".test.mjs") && !name.endsWith(".db.test.mjs"),
  )
  .sort()
  .map((name) => `tests/${name}`);

const result = spawnSync(
  process.execPath,
  [
    "--no-warnings",
    "--import",
    "./tests/route-loader.mjs",
    "--test",
    "--test-concurrency=1",
    ...files,
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(output);

// Take the LAST summary line: suites that exercise the DB runner print their
// own synthetic "ℹ skipped N" fixtures, which precede the real one.
const skipMatches = [...output.matchAll(/^ℹ skipped (\d+)$/gm)];
const skipped = Number(skipMatches.at(-1)?.[1] ?? 0);

if (result.error) {
  console.error(`Unit test runner failed: ${result.error.message}`);
  process.exitCode = 1;
} else if (skipped > 0) {
  console.error(
    [
      `BLOCKER[UNIT-SKIP]: ${skipped} unit test(s) were skipped.`,
      "The unit suite must be DB-free and unconditional: a skipped test is a",
      "failure, not a pass. A test that needs Postgres belongs in a",
      "tests/*.db.test.mjs file, where scripts/run-db-tests.mjs enforces the",
      "same zero-skip rule.",
    ].join("\n"),
  );
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
