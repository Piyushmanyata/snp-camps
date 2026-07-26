/**
 * #68 — Real Postgres catalog probe + readiness contract agreement.
 * Requires local Supabase Postgres (default 127.0.0.1:54322).
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_MIGRATION_HEAD,
  GRANT_EXPECTATIONS,
  PUBLICATION_EXPECTATIONS,
  REQUIRED_COLUMNS,
  REQUIRED_FUNCTIONS,
  REQUIRED_TABLES,
  SMS_DELIVERY_KINDS,
  SMS_DELIVERY_STATES,
} from "../src/lib/readiness-contract.ts";
import { evaluateCatalogFacts } from "../src/lib/readiness.ts";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @type {pg.Client | null} */
let admin = null;
let dbAvailable = false;

async function connect() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    const { rows } = await c.query(
      `select to_regprocedure('public.readiness_catalog_probe()') is not null as ok`,
    );
    if (!rows[0]?.ok) {
      await c.end();
      return null;
    }
    return c;
  } catch {
    try {
      await c.end();
    } catch {
      /* ignore */
    }
    return null;
  }
}

function skipIfNoDb(t) {
  if (!dbAvailable) {
    t.skip("local Postgres / readiness_catalog_probe not available");
    return true;
  }
  return false;
}

test.before(async () => {
  admin = await connect();
  dbAvailable = Boolean(admin);
  if (!dbAvailable) {
    console.warn(
      "[readiness.db] local Postgres or probe RPC unavailable — DB tests skipped",
    );
  }
});

test.after(async () => {
  if (admin) await admin.end();
});

test("repo migration head matches EXPECTED_MIGRATION_HEAD constant", () => {
  const migDir = path.join(root, "supabase", "migrations");
  const files = fs
    .readdirSync(migDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  assert.ok(files.length > 0);
  const headFile = files[files.length - 1];
  const head = headFile.slice(0, 14);
  assert.equal(
    head,
    EXPECTED_MIGRATION_HEAD,
    `Bump EXPECTED_MIGRATION_HEAD when adding migrations (repo=${head}, contract=${EXPECTED_MIGRATION_HEAD})`,
  );
});

test("applied ledger head agrees with contract after clean migrations", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await admin.query(
    `select public.latest_applied_migration() as version`,
  );
  assert.equal(rows[0].version, EXPECTED_MIGRATION_HEAD);
});

test("readiness_catalog_probe returns full contract facts on clean DB", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await admin.query(
    `select public.readiness_catalog_probe() as facts`,
  );
  const facts = rows[0].facts;
  assert.equal(typeof facts, "object");

  for (const table of REQUIRED_TABLES) {
    assert.equal(facts.tables[table], true, `table ${table}`);
  }
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    for (const col of cols) {
      assert.equal(
        facts.columns[`${table}.${col}`],
        true,
        `column ${table}.${col}`,
      );
    }
  }
  for (const fn of REQUIRED_FUNCTIONS) {
    assert.equal(facts.functions[fn], true, `function ${fn}`);
  }
  for (const [key, expected] of Object.entries(GRANT_EXPECTATIONS)) {
    assert.equal(facts.grants[key], expected, `grant ${key}`);
  }
  assert.equal(
    facts.publication.patients_in_supabase_realtime,
    PUBLICATION_EXPECTATIONS.patients_in_supabase_realtime,
  );
  assert.equal(facts.sms.table, true);
  assert.equal(facts.sms.claim_fn, true);
  assert.equal(facts.sms.complete_fn, true);
  for (const s of SMS_DELIVERY_STATES) {
    assert.equal(facts.sms.states[s], true, `sms state ${s}`);
  }
  for (const k of SMS_DELIVERY_KINDS) {
    assert.equal(facts.sms.kinds[k], true, `sms kind ${k}`);
  }

  const evald = evaluateCatalogFacts(facts);
  assert.equal(evald.schema_contract.ok, true);
  assert.equal(evald.rpc_grants.ok, true);
  assert.equal(evald.patients_realtime_absent.ok, true);
  assert.equal(evald.sms_ledger.ok, true);
});

test("patients absent from supabase_realtime (catalog fact)", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await admin.query(
    `select 1
     from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'patients'`,
  );
  assert.equal(rows.length, 0);
});

test("probe is not executable by anon or authenticated", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await admin.query(`
    select
      has_function_privilege('anon', 'public.readiness_catalog_probe()', 'EXECUTE') as anon_exec,
      has_function_privilege('authenticated', 'public.readiness_catalog_probe()', 'EXECUTE') as auth_exec,
      has_function_privilege('service_role', 'public.readiness_catalog_probe()', 'EXECUTE') as service_exec
  `);
  assert.equal(rows[0].anon_exec, false);
  assert.equal(rows[0].auth_exec, false);
  assert.equal(rows[0].service_exec, true);
});

test("evaluateCatalogFacts fails closed on missing critical column", () => {
  const facts = {
    tables: Object.fromEntries(REQUIRED_TABLES.map((t) => [t, true])),
    columns: Object.fromEntries(
      Object.entries(REQUIRED_COLUMNS).flatMap(([table, cols]) =>
        cols.map((c) => [`${table}.${c}`, true]),
      ),
    ),
    functions: Object.fromEntries(REQUIRED_FUNCTIONS.map((f) => [f, true])),
    grants: { ...GRANT_EXPECTATIONS },
    publication: { patients_in_supabase_realtime: false },
    sms: {
      table: true,
      states: Object.fromEntries(SMS_DELIVERY_STATES.map((s) => [s, true])),
      kinds: Object.fromEntries(SMS_DELIVERY_KINDS.map((k) => [k, true])),
      claim_fn: true,
      complete_fn: true,
    },
  };
  // Historical non-contract column absence is fine.
  delete facts.columns["patients.legacy_passcode"];

  let evald = evaluateCatalogFacts(facts);
  assert.equal(evald.schema_contract.ok, true);

  facts.columns["patients.status_token"] = false;
  evald = evaluateCatalogFacts(facts);
  assert.equal(evald.schema_contract.ok, false);
  assert.match(evald.schema_contract.detail, /status_token/);
});

test("probe output contains no PHI-looking fields", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await admin.query(
    `select public.readiness_catalog_probe()::text as raw`,
  );
  const raw = rows[0].raw;
  assert.ok(!/phone_normalized|full_name_normalized|@/.test(raw));
  assert.ok(!/postgres:\/\//.test(raw));
  // Should only be booleans / short keys — no long hex tokens.
  assert.ok(!/[0-9a-f]{32}/.test(raw));
});
