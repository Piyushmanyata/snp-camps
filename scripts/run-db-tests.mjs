import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isLocalConnectionError,
  redact,
  repoHeads,
} from "./compare-migration-heads.mjs";

export const DEFAULT_TEST_DATABASE_URL =
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function resolveTestDatabaseUrl(value = process.env.SNP_TEST_DATABASE_URL) {
  const raw = value || DEFAULT_TEST_DATABASE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid database URL");
  }

  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("remote database target");
  }
  return url.toString();
}

export function readConfiguredProjectId({
  readFileImpl = fs.readFileSync,
  configPath = path.join(root, "supabase", "config.toml"),
} = {}) {
  const text = readFileImpl(configPath, "utf8");
  const m = text.match(/^\s*project_id\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error("supabase/config.toml is missing project_id");
  return m[1];
}

export function expectedRepoHead() {
  return repoHeads().head;
}

function describeDatabaseTarget(raw) {
  try {
    const url = new URL(raw);
    return {
      host: url.hostname || "<empty>",
      database: url.pathname.replace(/^\/+/, "") || "<empty>",
      port: url.port || "<default>",
    };
  } catch {
    return { host: "<invalid>", database: "<invalid>", port: "<invalid>" };
  }
}

function blocker(reason) {
  console.error(`BLOCKER[UNSAFE-DB-TARGET]: ${reason}`);
  return 1;
}

export function inspectOwningDbProject({
  configuredProjectId,
  commandImpl = (file, args) =>
    execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
} = {}) {
  let namesText;
  try {
    namesText = commandImpl("docker", [
      "ps",
      "--filter",
      "name=supabase_db_",
      "--format",
      "{{.Names}}",
    ]);
  } catch (err) {
    const wrapped = new Error(
      `docker inspect failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    wrapped.code = "INSPECT_FAILED";
    throw wrapped;
  }
  const names = String(namesText || "")
    .split(/\r?\n/)
    .filter(Boolean);
  const name = names.find(
    (containerName) => containerName === `supabase_db_${configuredProjectId}`,
  );
  if (!name) return null;

  let portText = "";
  try {
    portText = commandImpl("docker", ["port", name, "5432"]);
  } catch {
    return null;
  }
  const mapped = Number(String(portText).match(/:(\d+)/)?.[1]);
  if (!mapped) return null;
  return {
    projectId: configuredProjectId,
    containerName: name,
    hostPort: mapped,
  };
}

export async function querySnpCatalog(databaseUrl) {
  let pg;
  try {
    pg = (await import("pg")).default;
  } catch (err) {
    const wrapped = new Error(
      `pg unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    wrapped.snpPhase = "connect";
    throw wrapped;
  }
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 3_000,
    query_timeout: 3_000,
  });
  try {
    await client.connect();
  } catch (err) {
    if (err && typeof err === "object") err.snpPhase = "connect";
    throw err;
  }
  try {
    const ledgerRes = await client.query(
      `select version from supabase_migrations.schema_migrations
       order by version desc limit 1`,
    );
    const probeRes = await client.query(
      `select public.latest_applied_migration() as version`,
    );
    const snpRes = await client.query(
      `select (
          to_regclass('public.patients') is not null
          and to_regclass('public.ot_schedule_days') is not null
          and exists (
            select 1 from information_schema.columns
            where table_schema = 'public'
              and table_name = 'patients'
              and column_name = 'printed_at'
          )
        ) as ok`,
    );
    return {
      ledger: ledgerRes.rows[0]?.version ?? null,
      probe: probeRes.rows[0]?.version ?? null,
      snpCatalog: snpRes.rows[0]?.ok === true,
    };
  } catch (err) {
    if (err && typeof err === "object") err.snpPhase = "query";
    throw err;
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}

export async function runDbTests({
  spawnSyncImpl = spawnSync,
  env = process.env,
  inspectProjectImpl = inspectOwningDbProject,
  queryCatalogImpl = querySnpCatalog,
  cleanupImpl,
  configuredProjectId = readConfiguredProjectId(),
  expectedHead = expectedRepoHead(),
} = {}) {
  const explicit = Boolean(env.SNP_TEST_DATABASE_URL);
  const requested = env.SNP_TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
  let databaseUrl;
  try {
    databaseUrl = resolveTestDatabaseUrl(env.SNP_TEST_DATABASE_URL);
  } catch {
    const { host, database } = describeDatabaseTarget(requested);
    return blocker(
      `host=${host} database=${database}; DB tests require a loopback SNP_TEST_DATABASE_URL.`,
    );
  }

  if (!explicit) {
    let owner;
    try {
      owner = inspectProjectImpl({ configuredProjectId });
    } catch (err) {
      return blocker(
        `inspect failed: ${redact(err instanceof Error ? err.message : String(err))}`,
      );
    }
    if (!owner || owner.projectId !== configuredProjectId) {
      return blocker(
        `project mismatch: owning=${owner?.projectId ?? "(none)"} expected=${configuredProjectId}`,
      );
    }
    const discovered = new URL(databaseUrl);
    discovered.port = String(owner.hostPort);
    databaseUrl = discovered.toString();
  }

  let catalog;
  try {
    catalog = await queryCatalogImpl(databaseUrl);
  } catch (err) {
    const phase =
      err?.snpPhase === "query" || !isLocalConnectionError(err)
        ? "schema query"
        : "connection";
    return blocker(
      `${phase} failed: ${redact(err instanceof Error ? err.message : String(err))}`,
    );
  }

  if (!catalog?.snpCatalog) {
    return blocker("foreign schema: SNP catalog invariant failed");
  }
  if (!catalog.probe) {
    return blocker("missing probe: latest_applied_migration() returned empty");
  }
  if (catalog.ledger !== expectedHead || catalog.probe !== expectedHead) {
    return blocker(
      `stale head: ledger=${catalog.ledger} probe=${catalog.probe} expected=${expectedHead}`,
    );
  }

  const dbTestFiles = fs
    .readdirSync("tests")
    .filter((name) => name.endsWith(".db.test.mjs"))
    .sort()
    .map((name) => `tests/${name}`);

  const childEnv = { ...env, SNP_TEST_DATABASE_URL: databaseUrl };
  delete childEnv.DATABASE_URL;
  const result = spawnSyncImpl(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      "./tests/route-loader.mjs",
      "--test",
      "--test-concurrency=1",
      ...dbTestFiles,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    },
  );

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(output);
  if (cleanupImpl) await cleanupImpl(databaseUrl);

  const metric = (name) =>
    Number(output.match(new RegExp(`^ℹ ${name} (\\d+)$`, "m"))?.[1] ?? 0);
  const skipped = metric("skipped");
  const summary = ["tests", "pass", "fail", "skipped", "todo"]
    .map((name) => `${name}=${metric(name)}`)
    .join(" ");

  console.log(`DB TEST SUMMARY: ${summary}`);

  if (skipped > 0) {
    console.error(
      [
        `BLOCKER[DB-UNAVAILABLE]: ${skipped} database test(s) were skipped.`,
        "Skipped database tests are a failure, not a pass.",
        "Start local Supabase Postgres (never production):",
        "  npx supabase start",
        "Then run the disposable replay suite:",
        "  npm run test:db:replay",
        "Default URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      ].join("\n"),
    );
    return 1;
  }
  if (result.error) {
    console.error(`BLOCKER[DB-RUNNER]: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

/**
 * Repair auth.users rows the suite seeds with raw SQL.
 *
 * GoTrue scans confirmation_token, recovery_token, email_change and
 * email_change_token_new into non-nullable Go strings. The DB tests insert
 * users directly and leave those columns NULL, which GoTrue cannot read: every
 * later call to the admin users API answers 500. `npm run verify` runs test:db
 * immediately before test:e2e, whose global setup starts with listUsers, so the
 * suite silently made the gate that follows it impossible to pass.
 *
 * Doing this once here also covers any future test that inserts a user without
 * the columns, which fixing today's call sites one by one would not.
 */
async function repairSeededAuthUsers(databaseUrl) {
  let pg;
  try {
    pg = (await import("pg")).default;
  } catch {
    return;
  }
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 3_000,
  });
  try {
    await client.connect();
    const { rowCount } = await client.query(
      `update auth.users
          set confirmation_token = coalesce(confirmation_token, ''),
              recovery_token = coalesce(recovery_token, ''),
              email_change = coalesce(email_change, ''),
              email_change_token_new = coalesce(email_change_token_new, ''),
              email_change_token_current = coalesce(email_change_token_current, ''),
              phone_change = coalesce(phone_change, ''),
              phone_change_token = coalesce(phone_change_token, ''),
              reauthentication_token = coalesce(reauthentication_token, '')
        where confirmation_token is null
           or recovery_token is null
           or email_change is null
           or email_change_token_new is null
           or email_change_token_current is null
           or phone_change is null
           or phone_change_token is null
           or reauthentication_token is null`,
    );
    if (rowCount > 0) {
      console.log(`DB TEST CLEANUP: repaired ${rowCount} seeded auth.users row(s)`);
    }
  } catch (err) {
    console.warn(
      `DB TEST CLEANUP: skipped (${err instanceof Error ? err.message : String(err)})`,
    );
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runDbTests({ cleanupImpl: repairSeededAuthUsers });
}
