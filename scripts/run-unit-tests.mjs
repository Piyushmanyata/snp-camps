import fs from "node:fs";
import { spawnSync } from "node:child_process";

const files = fs
  .readdirSync("tests")
  .filter(
    (name) =>
      name.endsWith(".test.mjs") &&
      !/\bfrom\s+["']pg["']/.test(
        fs.readFileSync(`tests/${name}`, "utf8"),
      ),
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
  { stdio: "inherit" },
);

if (result.error) {
  console.error(`Unit test runner failed: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
