import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const DEFAULT_TEST_DATABASE_URL =
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

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

function describeDatabaseTarget(raw) {
  try {
    const url = new URL(raw);
    return {
      host: url.hostname || "<empty>",
      database: url.pathname.replace(/^\/+/, "") || "<empty>",
    };
  } catch {
    return { host: "<invalid>", database: "<invalid>" };
  }
}

export function runDbTests({ spawnSyncImpl = spawnSync, env = process.env } = {}) {
  const requested = env.SNP_TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
  let databaseUrl;
  try {
    databaseUrl = resolveTestDatabaseUrl(env.SNP_TEST_DATABASE_URL);
  } catch {
    const { host, database } = describeDatabaseTarget(requested);
    console.error(
      `BLOCKER[UNSAFE-DB-TARGET]: host=${host} database=${database}; ` +
        "DB tests require a loopback SNP_TEST_DATABASE_URL.",
    );
    return 1;
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
async function repairSeededAuthUsers() {
  let pg;
  try {
    pg = (await import("pg")).default;
  } catch {
    return; // pg is a devDependency; nothing to repair without it.
  }
  const client = new pg.Client({
    connectionString: resolveTestDatabaseUrl(),
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
  process.exitCode = runDbTests();
  await repairSeededAuthUsers();
}
