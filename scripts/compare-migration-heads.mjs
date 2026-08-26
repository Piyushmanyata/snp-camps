#!/usr/bin/env node
/**
 * Read-only migration head comparison (#68).
 *
 * Compares:
 *   1) Repository migration files under supabase/migrations/
 *   2) Optional local applied head via DATABASE_URL / SNP_TEST_DATABASE_URL
 *   3) Optional linked remote via `npx supabase migration list` (never mutates)
 *
 * Never applies migrations, never repairs the ledger, never prints secrets.
 *
 * Usage:
 *   node scripts/compare-migration-heads.mjs
 *   npm run compare:migrations
 *
 * Exit codes:
 *   0 — all inspected heads agree (or only repo listed when DB unavailable)
 *   1 — mismatch or discovery failure when --require-local is set
 *   2 — usage / unexpected error
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LOCAL_DATABASE_URL =
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function readConfiguredProjectId() {
  const text = fs.readFileSync(path.join(root, "supabase", "config.toml"), "utf8");
  const match = text.match(/^\s*project_id\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error("supabase/config.toml is missing project_id");
  return match[1];
}

function inspectConfiguredDbProject({
  projectId,
  commandImpl = (file, args) =>
    execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
}) {
  const names = String(
    commandImpl("docker", [
      "ps",
      "--filter",
      "name=supabase_db_",
      "--format",
      "{{.Names}}",
    ]),
  )
    .split(/\r?\n/)
    .filter(Boolean);
  const containerName = names.find(
    (name) => name === `supabase_db_${projectId}`,
  );
  if (!containerName) return null;
  const portText = commandImpl("docker", ["port", containerName, "5432"]);
  const hostPort = Number(String(portText).match(/:(\d+)/)?.[1]);
  if (!hostPort) return null;
  return { projectId, containerName, hostPort };
}

export function repoHeads() {
  const migDir = path.join(root, "supabase", "migrations");
  const files = fs
    .readdirSync(migDir)
    .filter((f) => /^\d{14}_.+\.sql$/.test(f))
    .sort();
  return {
    count: files.length,
    head: files.length ? files[files.length - 1].slice(0, 14) : null,
    headFile: files.length ? files[files.length - 1] : null,
    files: files.map((f) => f.slice(0, 14)),
  };
}

export function headMigrationProbeLiteral(headFile) {
  const text = fs.readFileSync(
    path.join(root, "supabase", "migrations", headFile),
    "utf8",
  );
  const m = text.match(
    /FUNCTION\s+public\.latest_applied_migration\s*\(\s*\)[\s\S]*?SELECT\s*'(\d{14})'/i,
  );
  return m ? m[1] : null;
}

export function contractExpectedHead() {
  const contractPath = path.join(root, "src", "lib", "readiness-contract.ts");
  const text = fs.readFileSync(contractPath, "utf8");
  const m = text.match(
    /EXPECTED_MIGRATION_HEAD\s*=\s*["'](\d{14})["']/,
  );
  return m ? m[1] : null;
}

export function isLocalConnectionError(err) {
  if (err?.snpPhase === "query") return false;
  if (err?.snpPhase === "connect") return true;
  const code = err?.code;
  if (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET" ||
    code === "ENETUNREACH" ||
    code === "EHOSTUNREACH" ||
    code === "EAI_AGAIN" ||
    code === "ECONNABORTED"
  ) {
    return true;
  }
  const msg = String(err?.message || err);
  return (
    /connect(ion)? (timeout|refused|terminated)/i.test(msg) &&
    !/(does not exist|schema|relation|function)/i.test(msg)
  );
}

export function redact(text) {
  return String(text)
    .replace(/postgres:\/\/[^\s]+/gi, "postgres://***")
    .replace(/postgresql:\/\/[^\s]+/gi, "postgresql://***")
    .replace(/password[=:]\s*\S+/gi, "password=[REDACTED]")
    .replace(/sb_secret_[A-Za-z0-9_-]+/g, "sb_secret_***")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "jwt:***");
}

export async function localAppliedHead({
  env = process.env,
  configuredProjectId = readConfiguredProjectId(),
  inspectProjectImpl = inspectConfiguredDbProject,
  connect = async (url) => {
    const client = new pg.Client({
      connectionString: url,
      connectionTimeoutMillis: 3_000,
      query_timeout: 3_000,
    });
    await client.connect();
    return client;
  },
} = {}) {
  let url = env.SNP_TEST_DATABASE_URL || env.DATABASE_URL;
  if (!url) {
    let owner;
    try {
      owner = inspectProjectImpl({ projectId: configuredProjectId });
    } catch (err) {
      if (err && typeof err === "object") err.snpPhase = "connect";
      throw err;
    }
    if (!owner || owner.projectId !== configuredProjectId) {
      const err = new Error(
        `configured local Supabase project ${configuredProjectId} is not running`,
      );
      err.snpPhase = "connect";
      throw err;
    }
    const discovered = new URL(DEFAULT_LOCAL_DATABASE_URL);
    discovered.port = String(owner.hostPort);
    url = discovered.toString();
  }
  let client;
  try {
    client = await connect(url);
  } catch (err) {
    if (err && typeof err === "object") err.snpPhase = "connect";
    throw err;
  }
  try {
    const { rows } = await client.query(
      `select version from supabase_migrations.schema_migrations
       order by version desc limit 1`,
    );
    const { rows: probe } = await client.query(
      `select public.latest_applied_migration() as version`,
    );
    return {
      ledger: rows[0]?.version ?? null,
      probe: probe[0]?.version ?? null,
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

function linkedMigrationList() {
  const r = spawnSync("npx", ["supabase", "migration", "list"], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    shell: true,
  });
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

export async function compareMigrationHeads({
  argv = process.argv,
  env = process.env,
  queryLocal = () => localAppliedHead({ env }),
} = {}) {
  const requireLocal = argv.includes("--require-local");
  const skipLinked = argv.includes("--skip-linked");
  const repo = repoHeads();
  const expected = contractExpectedHead();

  console.log("=== Migration head comparison (read-only) ===");
  console.log(`repo_file_count: ${repo.count}`);
  console.log(`repo_head:       ${repo.head ?? "(none)"}`);
  console.log(`contract_head:   ${expected ?? "(unparsed)"}`);

  let exit = 0;

  if (!repo.head) {
    console.error("FAIL: no migration files found");
    return 1;
  }

  if (expected && expected !== repo.head) {
    console.error(
      `FAIL: contract EXPECTED_MIGRATION_HEAD (${expected}) != repo head (${repo.head}). Bump the constant.`,
    );
    exit = 1;
  } else if (expected === repo.head) {
    console.log("OK: contract head matches repository head");
  }

  const probeLiteral = headMigrationProbeLiteral(repo.headFile);
  console.log(`head_probe_sql:  ${probeLiteral ?? "(absent)"}`);
  if (probeLiteral === repo.head) {
    console.log("OK: head migration bumps latest_applied_migration()");
  } else {
    console.error(
      `FAIL: ${repo.headFile} must redefine latest_applied_migration() to return '${repo.head}' (found ${probeLiteral ?? "no definition"}). Readiness compares this literal against the ledger, so a stale one fails test:db with a head mismatch.`,
    );
    exit = 1;
  }

  let local = null;
  let localHead = null;
  let localProbe = null;
  let localError = null;
  let localPhase = null;
  try {
    local = await queryLocal();
    localHead = local.ledger;
    localProbe = local.probe;
    console.log(`local_applied:   ${localHead ?? "(empty ledger)"}`);
    console.log(`local_probe:     ${localProbe ?? "(no probe)"}`);
  } catch (err) {
    localError = err instanceof Error ? err.message : String(err);
    localPhase = err?.snpPhase ?? (isLocalConnectionError(err) ? "connect" : "query");
    console.log(
      `local_applied:   (${localPhase === "query" ? "query error" : "unavailable"}) ${redact(localError).slice(0, 120)}`,
    );
  }

  if (localHead !== null) {
    if (localHead === repo.head) {
      console.log("OK: local applied head matches repository head");
    } else {
      console.error(
        `FAIL: local applied head (${localHead}) != repo head (${repo.head})`,
      );
      exit = 1;
    }
    if (localProbe === repo.head) {
      console.log("OK: readiness probe head matches repository head");
    } else {
      console.error(
        `FAIL: latest_applied_migration() (${localProbe}) != repo head (${repo.head}). The head migration must bump the probe.`,
      );
      exit = 1;
    }
  } else if (localPhase === "query") {
    console.error(
      "FAIL: local database connected but schema/query failed (mismatch, not offline)",
    );
    exit = 1;
  } else if (requireLocal) {
    console.error("FAIL: --require-local set but local head could not be read");
    exit = 1;
  } else {
    console.log("SKIP: local database not reachable (ok for offline compare)");
  }

  if (!skipLinked) {
    console.log("--- linked project (supabase migration list; read-only) ---");
    const linked = linkedMigrationList();
    if (linked.status !== 0) {
      console.log(
        "SKIP: linked migration list unavailable (not linked or CLI error)",
      );
      if (linked.stderr) {
        console.log(redact(linked.stderr).trim().slice(0, 400));
      }
    } else {
      const lines = redact(linked.stdout)
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0);
      for (const line of lines.slice(0, 40)) {
        console.log(line);
      }
      if (lines.length > 40) {
        console.log(`… (${lines.length - 40} more lines redacted/truncated)`);
      }
      console.log(
        "NOTE: Inspect remote column for drift. This script never applies or repairs.",
      );
    }
  }

  console.log("=== end (no mutations performed) ===");
  return exit;
}

async function main() {
  const exit = await compareMigrationHeads();
  process.exit(exit);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("compare-migration-heads error:", redact(String(err.message || err)));
    process.exit(2);
  });
}
