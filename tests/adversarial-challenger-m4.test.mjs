/**
 * Adversarial Challenger M4-1 Verification Test Suite.
 * Validates test harness integrity, zero-skip enforcement, RPC breakage detection,
 * and honesty of the verification pipeline.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveTestDatabaseUrl,
  runDbTests,
  DEFAULT_TEST_DATABASE_URL,
} from "../scripts/run-db-tests.mjs";
import { EXPECTED_MIGRATION_HEAD } from "../src/lib/readiness-contract.ts";
import { classifyOperationError } from "../src/lib/public-error.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --------------------------------------------------------------------------
// PROBE 1: TEST HARNESS FAILURE CATCHING & ZERO-SKIP INVARIANT
// --------------------------------------------------------------------------

test("CHALLENGER PROBE 1.1: runDbTests returns exit code 1 when skipped > 0", () => {
  let loggedError = "";
  const originalError = console.error;
  console.error = (...args) => {
    loggedError += args.join(" ");
  };

  try {
    const status = runDbTests({
      env: { SNP_TEST_DATABASE_URL: DEFAULT_TEST_DATABASE_URL },
      spawnSyncImpl() {
        return {
          status: 0,
          stdout: "ℹ tests 10\nℹ pass 8\nℹ skipped 2\nℹ fail 0\n",
          stderr: "",
        };
      },
    });

    assert.equal(status, 1, "runDbTests must return 1 on any skipped tests");
    assert.match(
      loggedError,
      /BLOCKER\[DB-UNAVAILABLE\]: 2 database test\(s\) were skipped/,
      "Must emit loud blocker log for skipped tests",
    );
  } finally {
    console.error = originalError;
  }
});

test("CHALLENGER PROBE 1.2: runDbTests propagates child test failure code and runner errors", () => {
  // Test child failure exit code propagation
  const failStatus = runDbTests({
    env: { SNP_TEST_DATABASE_URL: DEFAULT_TEST_DATABASE_URL },
    spawnSyncImpl() {
      return {
        status: 1,
        stdout: "ℹ tests 10\nℹ pass 9\nℹ skipped 0\nℹ fail 1\n",
        stderr: "AssertionError: function missing_rpc does not exist",
      };
    },
  });
  assert.equal(failStatus, 1, "runDbTests must propagate child failure status");

  // Test child spawn error
  let loggedError = "";
  const originalError = console.error;
  console.error = (...args) => {
    loggedError += args.join(" ");
  };
  try {
    const errorStatus = runDbTests({
      env: { SNP_TEST_DATABASE_URL: DEFAULT_TEST_DATABASE_URL },
      spawnSyncImpl() {
        return {
          error: new Error("spawn failed"),
          status: null,
          stdout: "",
          stderr: "",
        };
      },
    });
    assert.equal(errorStatus, 1);
    assert.match(loggedError, /BLOCKER\[DB-RUNNER\]: spawn failed/);
  } finally {
    console.error = originalError;
  }
});

test("CHALLENGER PROBE 1.3: resolveTestDatabaseUrl rejects unsafe / non-loopback hosts", () => {
  const safeHosts = [
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    "postgresql://postgres:postgres@localhost:54322/postgres",
    "postgresql://postgres:postgres@[::1]:54322/postgres",
  ];
  for (const url of safeHosts) {
    assert.doesNotThrow(() => resolveTestDatabaseUrl(url));
  }

  const unsafeHosts = [
    "postgresql://postgres:postgres@db.prod.supabase.co:5432/postgres",
    "postgresql://postgres:postgres@192.168.1.50:5432/postgres",
    "postgresql://postgres:postgres@10.0.0.1:5432/postgres",
    "postgresql://postgres:postgres@example.com/postgres",
  ];
  for (const url of unsafeHosts) {
    assert.throws(
      () => resolveTestDatabaseUrl(url),
      /remote database target/,
      `Must reject unsafe host: ${url}`,
    );
  }
});

// --------------------------------------------------------------------------
// PROBE 2: ALL 27 .db.test.mjs SUITES HAVE HONEST REACHABILITY GUARDS
// --------------------------------------------------------------------------

test("CHALLENGER PROBE 2: All 33 .db.test.mjs suites contain NO to_regprocedure in their connect helper", () => {
  const testsDir = path.join(root, "tests");
  const dbTestFiles = fs
    .readdirSync(testsDir)
    .filter((f) => f.endsWith(".db.test.mjs"));

  assert.equal(
    dbTestFiles.length,
    33,
    `Expected exactly 33 .db.test.mjs files, found ${dbTestFiles.length}`,
  );

  for (const file of dbTestFiles) {
    const content = fs.readFileSync(path.join(testsDir, file), "utf8");

    // Any connect helper, however named (connect, connectDb, connectClient…)
    // and however declared. Matching only `async function connect(` let three
    // suites keep the banned probe behind a `connectDb` alias.
    //
    // This is a source-text probe and so is inherently partial — a helper named
    // makeClient() still evades it. The authoritative guard is outcome-based:
    // scripts/run-db-tests.mjs fails the run on any skip, whatever caused it.
    const helpers = [
      ...content.matchAll(
        /async function (connect\w*)\([^)]*\)\s*\{([\s\S]*?)\n\}/g,
      ),
      ...content.matchAll(
        /(?:const|let|var) (connect\w*)\s*=\s*async\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\}/g,
      ),
    ];

    for (const [, name, body] of helpers) {
      assert.ok(
        !body.includes("to_regprocedure"),
        `File ${file} contains to_regprocedure in ${name}() body! This suppresses broken RPC failures!`,
      );
      assert.ok(
        body.includes(".connect()"),
        `File ${file} ${name}() does not call .connect()`,
      );
    }
  }
});

// --------------------------------------------------------------------------
// PROBE 3: MIGRATION CHAIN & CONTRACT INTEGRITY
// --------------------------------------------------------------------------

test("CHALLENGER PROBE 3: Latest migration matches EXPECTED_MIGRATION_HEAD exactly", () => {
  const migDir = path.join(root, "supabase", "migrations");
  const sqlFiles = fs
    .readdirSync(migDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  assert.ok(sqlFiles.length >= 84, `Expected >= 84 migrations, found ${sqlFiles.length}`);
  const latestFile = sqlFiles[sqlFiles.length - 1];
  const latestVersion = latestFile.slice(0, 14);

  assert.equal(
    latestVersion,
    EXPECTED_MIGRATION_HEAD,
    `Latest migration (${latestVersion}) does not match EXPECTED_MIGRATION_HEAD (${EXPECTED_MIGRATION_HEAD})`,
  );
});

// --------------------------------------------------------------------------
// PROBE 4: ERROR CLASSIFICATION SAFETY & INFORMATION PRIVACY
// --------------------------------------------------------------------------

test("CHALLENGER PROBE 4: classifyOperationError masks Postgres internal error details", () => {
  const internalError = {
    code: "XX000",
    message: "internal error in pg_catalog.pg_proc query",
    details: "Failed to open relation secret_patients_table",
    hint: "Rebuild index on auth.users",
  };

  const classified = classifyOperationError(internalError, { log: false });
  assert.equal(classified.publicCategory, "unknown");
  assert.equal(classified.retryable, false);
  assert.ok(!classified.publicMessage.includes("secret_patients_table"));
  assert.ok(!classified.publicMessage.includes("pg_catalog"));
  assert.ok(!classified.publicMessage.includes("auth.users"));
});
