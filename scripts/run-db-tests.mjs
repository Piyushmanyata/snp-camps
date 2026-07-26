import { spawnSync } from "node:child_process";

const dbTestFiles = [
  "tests/register-patient-idempotent.db.test.mjs",
  "tests/staff-person-kpis.db.test.mjs",
  "tests/aadhaar-duplicate.db.test.mjs",
  "tests/check-in.db.test.mjs",
  "tests/likely-duplicate.db.test.mjs",
  "tests/likely-duplicate-concurrency.db.test.mjs",
  "tests/sms-deliveries.db.test.mjs",
  "tests/patient-read-boundary.db.test.mjs",
  "tests/assign-waiting-before-seen.db.test.mjs",
  "tests/patient-auth-retirement.db.test.mjs",
  "tests/status-queue-position.db.test.mjs",
  "tests/camp-day-capacity-concurrency.db.test.mjs",
  "tests/ops-readiness.test.mjs",
];

const result = spawnSync(
  process.execPath,
  [
    "--no-warnings",
    "--import",
    "./tests/route-loader.mjs",
    "--test",
    "--test-concurrency=1",
    ...dbTestFiles,
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(output);

const metric = (name) =>
  Number(output.match(new RegExp(`^ℹ ${name} (\\d+)$`, "m"))?.[1] ?? 0);
const skipped = metric("skipped");
const summary = ["tests", "pass", "fail", "skipped", "todo"]
  .map((name) => `${name}=${metric(name)}`)
  .join(" ");

console.log(`DB TEST SUMMARY: ${summary}`);

if (skipped > 0) {
  console.error(
    `BLOCKER[DB-UNAVAILABLE]: ${skipped} database test(s) were skipped. ` +
      "Local Postgres and the required migrations must be available; skipped tests are not passes.",
  );
  process.exitCode = 1;
} else if (result.error) {
  console.error(`BLOCKER[DB-RUNNER]: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
