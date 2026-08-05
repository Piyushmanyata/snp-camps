import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveTestDatabaseUrl,
  runDbTests,
} from "../scripts/run-db-tests.mjs";
import {
  authSetupError,
  serializeAuthError,
} from "../e2e/global-setup.ts";

test("DB runner accepts only loopback test database URLs", () => {
  assert.equal(
    resolveTestDatabaseUrl("postgresql://user:secret@127.0.0.1:54322/postgres"),
    "postgresql://user:secret@127.0.0.1:54322/postgres",
  );
  assert.equal(
    resolveTestDatabaseUrl("postgresql://user:secret@[::1]:54322/postgres"),
    "postgresql://user:secret@[::1]:54322/postgres",
  );
  assert.throws(
    () => resolveTestDatabaseUrl("postgresql://user:secret@db.example.com/app"),
    /remote database target/,
  );
});

test("remote DB target is rejected before the child test runner is spawned", () => {
  let spawned = false;
  let message = "";
  const originalError = console.error;
  console.error = (...args) => {
    message += args.join(" ");
  };
  try {
    const status = runDbTests({
      env: {
        SNP_TEST_DATABASE_URL: "postgresql://dbuser:dbsecret@prod.example.com/prod",
        DATABASE_URL: "postgresql://legacy:legacy@prod.example.com/prod",
      },
      spawnSyncImpl() {
        spawned = true;
        throw new Error("network connection must not be attempted");
      },
    });
    assert.equal(status, 1);
  } finally {
    console.error = originalError;
  }

  assert.equal(spawned, false);
  assert.match(message, /BLOCKER\[UNSAFE-DB-TARGET\]/);
  assert.match(message, /host=prod\.example\.com database=prod/);
  assert.doesNotMatch(message, /dbuser|dbsecret|legacy/);
});

test("DB runner passes only the validated test URL to child tests", () => {
  let childOptions;
  const status = runDbTests({
    env: {
      SNP_TEST_DATABASE_URL: "postgresql://postgres:postgres@localhost:54322/postgres",
      DATABASE_URL: "postgresql://legacy:legacy@remote.example.com/prod",
      KEEP_ME: "yes",
    },
    spawnSyncImpl(_file, _args, options) {
      childOptions = options;
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(status, 0);
  assert.equal(childOptions.env.SNP_TEST_DATABASE_URL, "postgresql://postgres:postgres@localhost:54322/postgres");
  assert.equal(childOptions.env.DATABASE_URL, undefined);
  assert.equal(childOptions.env.KEEP_ME, "yes");
});

test("Auth setup diagnostics keep only safe structured fields", () => {
  const error = {
    name: "AuthApiError",
    status: 502,
    code: "gateway_error",
    message: "Auth gateway unavailable",
    headers: { authorization: "Bearer secret" },
    request: { body: { password: "secret" } },
  };
  assert.deepEqual(serializeAuthError(error), {
    name: "AuthApiError",
    status: 502,
    code: "gateway_error",
    message: "Auth gateway unavailable",
  });
  const setupError = authSetupError("preflight", error);
  assert.match(setupError.message, /AuthApiError/);
  assert.match(setupError.message, /502/);
  assert.match(setupError.message, /gateway_error/);
  assert.match(setupError.message, /npx supabase start/);
  assert.doesNotMatch(setupError.message, /authorization|Bearer|password|secret/);
});
