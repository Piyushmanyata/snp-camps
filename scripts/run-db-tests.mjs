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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runDbTests();
}
