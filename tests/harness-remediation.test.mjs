import assert from "node:assert/strict";
import test from "node:test";
import {
  expectedRepoHead,
  readConfiguredProjectId,
  resolveTestDatabaseUrl,
  runDbTests,
} from "../scripts/run-db-tests.mjs";
import {
  compareMigrationHeads,
  contractExpectedHead,
  localAppliedHead,
} from "../scripts/compare-migration-heads.mjs";
import {
  discoverLocalSupabase,
  resolveNpmCli,
  spawnProductionBuild,
} from "../e2e/run-local.mjs";
import {
  authSetupError,
  serializeAuthError,
} from "../e2e/global-setup.ts";

const HEAD = expectedRepoHead();
const PROJECT_ID = readConfiguredProjectId();
const LOOPBACK_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ANON = "test-anon-key-not-a-secret-for-assert";
const SERVICE = "test-service-key-not-a-secret-for-assert";

function matchingCatalog() {
  return { ledger: HEAD, probe: HEAD, snpCatalog: true };
}

async function captureError(fn) {
  let message = "";
  const originalError = console.error;
  console.error = (...args) => {
    message += args.join(" ");
  };
  try {
    const status = await fn();
    return { status, message };
  } finally {
    console.error = originalError;
  }
}

async function captureLogs(fn) {
  let logs = "";
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => {
    logs += args.join(" ") + "\n";
  };
  console.error = (...args) => {
    logs += args.join(" ") + "\n";
  };
  try {
    const status = await fn();
    return { status, logs };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

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

test("remote DB target is rejected before the child test runner is spawned", async () => {
  let spawned = false;
  let catalogCalled = false;
  const { status, message } = await captureError(() =>
    runDbTests({
      env: {
        SNP_TEST_DATABASE_URL: "postgresql://dbuser:dbsecret@prod.example.com/prod",
        DATABASE_URL: "postgresql://legacy:legacy@prod.example.com/prod",
      },
      queryCatalogImpl() {
        catalogCalled = true;
        return matchingCatalog();
      },
      spawnSyncImpl() {
        spawned = true;
        throw new Error("network connection must not be attempted");
      },
    }),
  );

  assert.equal(status, 1);
  assert.equal(spawned, false);
  assert.equal(catalogCalled, false);
  assert.match(message, /BLOCKER\[UNSAFE-DB-TARGET\]/);
  assert.match(message, /host=prod\.example\.com database=prod/);
  assert.doesNotMatch(message, /dbuser|dbsecret|legacy/);
});

test("foreign loopback schema is rejected before spawn", async () => {
  let spawned = false;
  const { status, message } = await captureError(() =>
    runDbTests({
      env: { SNP_TEST_DATABASE_URL: LOOPBACK_URL },
      queryCatalogImpl: async () => ({ ledger: HEAD, probe: HEAD, snpCatalog: false }),
      spawnSyncImpl() {
        spawned = true;
        return { status: 0, stdout: "", stderr: "" };
      },
    }),
  );
  assert.equal(status, 1);
  assert.equal(spawned, false);
  assert.match(message, /BLOCKER\[UNSAFE-DB-TARGET\]/);
  assert.match(message, /foreign schema/);
});

test("auto-discovered same-schema wrong local project is rejected before spawn", async () => {
  let spawned = false;
  let catalogCalled = false;
  const { status, message } = await captureError(() =>
    runDbTests({
      env: {},
      configuredProjectId: PROJECT_ID,
      inspectProjectImpl: () => ({
        projectId: "aptus_barcode",
        containerName: "supabase_db_aptus_barcode",
        hostPort: 54322,
      }),
      queryCatalogImpl: async () => {
        catalogCalled = true;
        return matchingCatalog();
      },
      spawnSyncImpl() {
        spawned = true;
        return { status: 0, stdout: "", stderr: "" };
      },
    }),
  );
  assert.equal(status, 1);
  assert.equal(spawned, false);
  assert.equal(catalogCalled, false);
  assert.match(message, /BLOCKER\[UNSAFE-DB-TARGET\]/);
  assert.match(message, /project mismatch/);
  assert.match(message, /aptus_barcode/);
  assert.match(message, new RegExp(PROJECT_ID));
});

test("missing readiness probe is rejected before spawn", async () => {
  let spawned = false;
  const { status, message } = await captureError(() =>
    runDbTests({
      env: { SNP_TEST_DATABASE_URL: LOOPBACK_URL },
      queryCatalogImpl: async () => ({ ledger: HEAD, probe: null, snpCatalog: true }),
      spawnSyncImpl() {
        spawned = true;
        return { status: 0, stdout: "", stderr: "" };
      },
    }),
  );
  assert.equal(status, 1);
  assert.equal(spawned, false);
  assert.match(message, /BLOCKER\[UNSAFE-DB-TARGET\]/);
  assert.match(message, /missing probe/);
});

test("stale migration heads are rejected before spawn", async () => {
  let spawned = false;
  const { status, message } = await captureError(() =>
    runDbTests({
      env: { SNP_TEST_DATABASE_URL: LOOPBACK_URL },
      queryCatalogImpl: async () => ({
        ledger: "20260101000000",
        probe: HEAD,
        snpCatalog: true,
      }),
      spawnSyncImpl() {
        spawned = true;
        return { status: 0, stdout: "", stderr: "" };
      },
    }),
  );
  assert.equal(status, 1);
  assert.equal(spawned, false);
  assert.match(message, /BLOCKER\[UNSAFE-DB-TARGET\]/);
  assert.match(message, /stale head/);
  assert.match(message, /20260101000000/);
});

test("connection failure is rejected before spawn", async () => {
  let spawned = false;
  const { status, message } = await captureError(() =>
    runDbTests({
      env: { SNP_TEST_DATABASE_URL: LOOPBACK_URL },
      queryCatalogImpl: async () => {
        const err = new Error("connect ECONNREFUSED 127.0.0.1:54322");
        err.code = "ECONNREFUSED";
        err.snpPhase = "connect";
        throw err;
      },
      spawnSyncImpl() {
        spawned = true;
        return { status: 0, stdout: "", stderr: "" };
      },
    }),
  );
  assert.equal(status, 1);
  assert.equal(spawned, false);
  assert.match(message, /BLOCKER\[UNSAFE-DB-TARGET\]/);
  assert.match(message, /connection failed/);
});

test("explicit loopback override still runs schema safety checks before spawn", async () => {
  let spawned = false;
  let catalogUrl = null;
  let inspectCalled = false;
  const { status, message } = await captureError(() =>
    runDbTests({
      env: { SNP_TEST_DATABASE_URL: LOOPBACK_URL },
      inspectProjectImpl() {
        inspectCalled = true;
        throw new Error("inspect must not run for explicit URL");
      },
      queryCatalogImpl: async (url) => {
        catalogUrl = url;
        return { ledger: "20260101000000", probe: "20260101000000", snpCatalog: true };
      },
      spawnSyncImpl() {
        spawned = true;
        return { status: 0, stdout: "", stderr: "" };
      },
    }),
  );
  assert.equal(inspectCalled, false);
  assert.equal(catalogUrl, LOOPBACK_URL);
  assert.equal(spawned, false);
  assert.equal(status, 1);
  assert.match(message, /BLOCKER\[UNSAFE-DB-TARGET\]/);
  assert.match(message, /stale head/);
});

test("DB runner passes only the validated test URL to child tests", async () => {
  let childOptions;
  const status = await runDbTests({
    env: {
      SNP_TEST_DATABASE_URL: "postgresql://postgres:postgres@localhost:54322/postgres",
      DATABASE_URL: "postgresql://legacy:legacy@remote.example.com/prod",
      KEEP_ME: "yes",
    },
    queryCatalogImpl: async () => matchingCatalog(),
    spawnSyncImpl(_file, _args, options) {
      childOptions = options;
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(status, 0);
  assert.equal(
    childOptions.env.SNP_TEST_DATABASE_URL,
    "postgresql://postgres:postgres@localhost:54322/postgres",
  );
  assert.equal(childOptions.env.DATABASE_URL, undefined);
  assert.equal(childOptions.env.KEEP_ME, "yes");
});

test("auto-discovered matching project and catalog authorizes spawn", async () => {
  let spawned = false;
  let catalogUrl = null;
  let childUrl = null;
  let cleanupUrl = null;
  const status = await runDbTests({
    env: {},
    configuredProjectId: PROJECT_ID,
    inspectProjectImpl: () => ({
      projectId: PROJECT_ID,
      containerName: `supabase_db_${PROJECT_ID}`,
      hostPort: 55422,
    }),
    queryCatalogImpl: async (url) => {
      catalogUrl = url;
      return matchingCatalog();
    },
    spawnSyncImpl(_file, _args, options) {
      spawned = true;
      childUrl = options.env.SNP_TEST_DATABASE_URL;
      return { status: 0, stdout: "", stderr: "" };
    },
    cleanupImpl: async (url) => {
      cleanupUrl = url;
    },
  });
  assert.equal(status, 0);
  assert.equal(spawned, true);
  assert.equal(
    catalogUrl,
    "postgresql://postgres:postgres@127.0.0.1:55422/postgres",
  );
  assert.equal(childUrl, catalogUrl);
  assert.equal(cleanupUrl, catalogUrl);
});

test("connected schema query error is a mismatch, not offline", async () => {
  const { status, logs } = await captureLogs(() =>
    compareMigrationHeads({
      argv: ["node", "scripts/compare-migration-heads.mjs", "--skip-linked"],
      queryLocal: async () => {
        const err = new Error(
          'relation "supabase_migrations.schema_migrations" does not exist',
        );
        err.snpPhase = "query";
        throw err;
      },
    }),
  );
  assert.equal(status, 1);
  assert.match(logs, /FAIL: local database connected but schema\/query failed/);
  assert.doesNotMatch(logs, /SKIP: local database not reachable/);
  assert.doesNotMatch(logs, /ok for offline compare/);
});

test("local migration comparison discovers the configured project's database port", async () => {
  let connectedUrl = null;
  let queryCount = 0;
  const result = await localAppliedHead({
    env: {},
    configuredProjectId: PROJECT_ID,
    inspectProjectImpl: () => ({
      projectId: PROJECT_ID,
      containerName: `supabase_db_${PROJECT_ID}`,
      hostPort: 55422,
    }),
    connect: async (url) => {
      connectedUrl = url;
      return {
        async query() {
          queryCount += 1;
          return {
            rows: [{ version: HEAD }],
          };
        },
        async end() {},
      };
    },
  });

  assert.equal(
    connectedUrl,
    "postgresql://postgres:postgres@127.0.0.1:55422/postgres",
  );
  assert.equal(queryCount, 2);
  assert.deepEqual(result, { ledger: HEAD, probe: HEAD });
});

test("connection refused without --require-local stays offline skip", async () => {
  const { status, logs } = await captureLogs(() =>
    compareMigrationHeads({
      argv: ["node", "scripts/compare-migration-heads.mjs", "--skip-linked"],
      queryLocal: async () => {
        const err = new Error("connect ECONNREFUSED 127.0.0.1:54322");
        err.code = "ECONNREFUSED";
        err.snpPhase = "connect";
        throw err;
      },
    }),
  );
  assert.equal(status, 0);
  assert.match(logs, /SKIP: local database not reachable/);
});

test("--require-local connection failure is a hard fail", async () => {
  const { status, logs } = await captureLogs(() =>
    compareMigrationHeads({
      argv: [
        "node",
        "scripts/compare-migration-heads.mjs",
        "--skip-linked",
        "--require-local",
      ],
      queryLocal: async () => {
        const err = new Error("connect ECONNREFUSED 127.0.0.1:54322");
        err.code = "ECONNREFUSED";
        err.snpPhase = "connect";
        throw err;
      },
    }),
  );
  assert.equal(status, 1);
  assert.match(logs, /FAIL: --require-local set but local head could not be read/);
});

test("package.json verify requires a local migration comparison", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(pkg.scripts.verify, /compare:migrations/);
  assert.match(pkg.scripts.verify, /--require-local/);
});

function dockerDiscovery({ names, envText, portText, storageEnvText = "" }) {
  return (file, args) => {
    assert.equal(file, "docker");
    if (args[0] === "ps") return names;
    if (args[0] === "inspect") {
      const target = args.at(-1);
      if (String(target).startsWith("supabase_storage_")) return storageEnvText;
      return envText;
    }
    if (args[0] === "port") return portText;
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
}

test("E2E discovery with zero local projects fails with one actionable error", () => {
  assert.throws(
    () =>
      discoverLocalSupabase({
        env: {},
        configuredProjectId: PROJECT_ID,
        commandImpl: dockerDiscovery({ names: "", envText: "", portText: "" }),
      }),
    (err) => {
      assert.match(String(err.message), /E2E discovery failed/);
      assert.match(String(err.message), /E2E_SUPABASE_URL/);
      assert.doesNotMatch(String(err.message), /eyJ|jwt|ANON_KEY=|SERVICE_KEY=/);
      return true;
    },
  );
});

test("E2E discovery selects the configured project URL and credential source", () => {
  const found = discoverLocalSupabase({
    env: {},
    configuredProjectId: PROJECT_ID,
    commandImpl: dockerDiscovery({
      names: `supabase_kong_${PROJECT_ID}`,
      envText: `ANON_KEY=${ANON}\nSERVICE_KEY=${SERVICE}`,
      portText: "0.0.0.0:54321",
    }),
  });
  assert.equal(found.url, "http://127.0.0.1:54321");
  assert.equal(found.anonKey, ANON);
  assert.equal(found.serviceKey, SERVICE);
  assert.equal(found.source, "docker");
  assert.equal(found.projectId, PROJECT_ID);
});

test("E2E discovery of one incorrect local project does not select it", () => {
  assert.throws(
    () =>
      discoverLocalSupabase({
        env: {},
        configuredProjectId: PROJECT_ID,
        commandImpl: dockerDiscovery({
          names: "supabase_kong_aptus_barcode",
          envText: `ANON_KEY=${ANON}\nSERVICE_KEY=${SERVICE}`,
          portText: "0.0.0.0:54321",
        }),
      }),
    /E2E discovery failed/,
  );
});

test("E2E discovery selects the configured project among multiple local projects", () => {
  const found = discoverLocalSupabase({
    env: {},
    configuredProjectId: PROJECT_ID,
    commandImpl: dockerDiscovery({
      names: `supabase_kong_${PROJECT_ID}\nsupabase_kong_aptus_barcode`,
      envText: `ANON_KEY=${ANON}\nSERVICE_KEY=${SERVICE}`,
      portText: "0.0.0.0:54321",
    }),
  });
  assert.equal(found.url, "http://127.0.0.1:54321");
  assert.equal(found.projectId, PROJECT_ID);
});

test("explicit E2E project id selects that project among multiples", () => {
  const found = discoverLocalSupabase({
    env: { E2E_SUPABASE_PROJECT_ID: PROJECT_ID },
    configuredProjectId: PROJECT_ID,
    commandImpl: dockerDiscovery({
      names: `supabase_kong_${PROJECT_ID}\nsupabase_kong_aptus_barcode`,
      envText: `ANON_KEY=${ANON}\nSERVICE_KEY=${SERVICE}`,
      portText: "127.0.0.1:54331",
    }),
  });
  assert.equal(found.url, "http://127.0.0.1:54331");
  assert.equal(found.source, "docker");
  assert.equal(found.anonKey, ANON);
});

test("E2E discovery never falls back to fabricated keys", () => {
  assert.throws(
    () =>
      discoverLocalSupabase({
        env: {},
        configuredProjectId: PROJECT_ID,
        commandImpl: dockerDiscovery({ names: "", envText: "", portText: "" }),
      }),
    (err) => {
      assert.doesNotMatch(String(err.message), /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/);
      return /E2E discovery failed/.test(String(err.message));
    },
  );
});

test("E2E production build spawn is argument-safe and does not use a shell", () => {
  let spawnFile;
  let spawnArgs;
  let spawnOptions;
  spawnProductionBuild({
    spawnSyncImpl(file, args, options) {
      spawnFile = file;
      spawnArgs = args;
      spawnOptions = options;
      return { status: 0 };
    },
    env: { NODE_ENV: "production" },
    npmCli: "/virtual/npm-cli.js",
  });
  assert.equal(spawnFile, process.execPath);
  assert.ok(Array.isArray(spawnArgs));
  assert.equal(spawnArgs[0], "/virtual/npm-cli.js");
  assert.deepEqual(spawnArgs.slice(1), ["run", "build"]);
  assert.notEqual(spawnOptions.shell, true);
  assert.equal(typeof spawnArgs, "object");
});

test("E2E npm CLI resolution uses npm_execpath when npm is not beside Node", () => {
  const npmExecPath = "/opt/hostedtoolcache/node/lib/node_modules/npm/bin/npm-cli.js";
  const resolved = resolveNpmCli({
    env: { npm_execpath: npmExecPath },
    execPath: "/opt/hostedtoolcache/node/bin/node",
    existsImpl(path) {
      return path === npmExecPath;
    },
    requireImpl: {
      resolve() {
        throw new Error("Cannot find module 'npm/bin/npm-cli.js'");
      },
    },
  });
  assert.equal(resolved, npmExecPath);
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

test("configured project id and contract head are the shipped values", () => {
  assert.equal(PROJECT_ID, "snp-camps");
  assert.equal(HEAD, contractExpectedHead());
  assert.match(HEAD, /^\d{14}$/);
});
