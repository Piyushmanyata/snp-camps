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
import { spawnSync } from "node:child_process";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireLocal = process.argv.includes("--require-local");
const skipLinked = process.argv.includes("--skip-linked");

function repoHeads() {
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

// latest_applied_migration() returns a hard-coded literal that the head
// migration has to bump; readiness compares it against the ledger. The DB check
// below catches a stale one, but only when Postgres is reachable — so read the
// literal out of the head migration file too, and catch it with no Docker.
function headMigrationProbeLiteral(headFile) {
  const text = fs.readFileSync(
    path.join(root, "supabase", "migrations", headFile),
    "utf8",
  );
  const m = text.match(
    /FUNCTION\s+public\.latest_applied_migration\s*\(\s*\)[\s\S]*?SELECT\s*'(\d{14})'/i,
  );
  return m ? m[1] : null;
}

function contractExpectedHead() {
  const contractPath = path.join(root, "src", "lib", "readiness-contract.ts");
  const text = fs.readFileSync(contractPath, "utf8");
  const m = text.match(
    /EXPECTED_MIGRATION_HEAD\s*=\s*["'](\d{14})["']/,
  );
  return m ? m[1] : null;
}

async function localAppliedHead() {
  const url =
    process.env.SNP_TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  // Never log the URL (may contain credentials on non-local envs).
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 3_000,
    query_timeout: 3_000,
  });
  try {
    await client.connect();
    const { rows } = await client.query(
      `select version from supabase_migrations.schema_migrations
       order by version desc limit 1`,
    );
    // The ledger advances on its own; the readiness probe only advances when a
    // migration remembers to bump it. Read both so a lagging probe is caught
    // offline instead of at deploy time.
    const { rows: probe } = await client.query(
      `select public.latest_applied_migration() as version`,
    );
    return {
      ledger: rows[0]?.version ?? null,
      probe: probe[0]?.version ?? null,
    };
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

function redact(text) {
  return text
    .replace(/postgres:\/\/[^\s]+/gi, "postgres://***")
    .replace(/password[=:]\s*\S+/gi, "password=***")
    .replace(/sb_secret_[A-Za-z0-9_-]+/g, "sb_secret_***")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "jwt:***");
}

async function main() {
  const repo = repoHeads();
  const expected = contractExpectedHead();

  console.log("=== Migration head comparison (read-only) ===");
  console.log(`repo_file_count: ${repo.count}`);
  console.log(`repo_head:       ${repo.head ?? "(none)"}`);
  console.log(`contract_head:   ${expected ?? "(unparsed)"}`);

  let exit = 0;

  if (!repo.head) {
    console.error("FAIL: no migration files found");
    process.exit(1);
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
  try {
    local = await localAppliedHead();
    localHead = local.ledger;
    localProbe = local.probe;
    console.log(`local_applied:   ${localHead ?? "(empty ledger)"}`);
    console.log(`local_probe:     ${localProbe ?? "(no probe)"}`);
  } catch (err) {
    localError = err instanceof Error ? err.message : String(err);
    // Do not print connection strings that might appear in driver messages.
    console.log(
      `local_applied:   (unavailable) ${redact(localError).slice(0, 120)}`,
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
      // Print a redacted summary only — never full env dumps.
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
  process.exit(exit);
}

main().catch((err) => {
  console.error("compare-migration-heads error:", redact(String(err.message || err)));
  process.exit(2);
});
