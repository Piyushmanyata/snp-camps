/**
 * #68 — live Postgres readiness catalog verification.
 * Requires local Supabase Postgres (default 127.0.0.1:54322).
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  EXPECTED_MIGRATION_HEAD,
  GRANT_EXPECTATIONS,
  PUBLICATION_EXPECTATIONS,
  REQUIRED_COLUMNS,
  REQUIRED_FUNCTIONS,
  REQUIRED_INVARIANTS,
  REQUIRED_TABLES,
  SMS_DELIVERY_KINDS,
  SMS_DELIVERY_STATES,
} from "../src/lib/readiness-contract.ts";
import { evaluateCatalogFacts } from "../src/lib/readiness.ts";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/** @type {pg.Client | null} */
let admin = null;
let dbAvailable = false;

async function connect() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    const { rows } = await client.query(
      `select to_regprocedure('public.readiness_catalog_probe()') is not null as ok`,
    );
    if (!rows[0]?.ok) {
      await client.end();
      return null;
    }
    return client;
  } catch {
    try {
      await client.end();
    } catch {
      // Ignore cleanup failure after an unavailable local database.
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
      "[ops-readiness] local Postgres or probe RPC unavailable — DB tests skipped",
    );
  }
});

test.after(async () => {
  if (admin) await admin.end();
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
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    for (const column of columns) {
      assert.equal(
        facts.columns[`${table}.${column}`],
        true,
        `column ${table}.${column}`,
      );
    }
  }
  for (const fn of REQUIRED_FUNCTIONS) {
    assert.equal(facts.functions[fn], true, `function ${fn}`);
  }
  for (const invariant of REQUIRED_INVARIANTS) {
    assert.equal(facts.invariants[invariant], true, `invariant ${invariant}`);
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
  for (const state of SMS_DELIVERY_STATES) {
    assert.equal(facts.sms.states[state], true, `sms state ${state}`);
  }
  for (const kind of SMS_DELIVERY_KINDS) {
    assert.equal(facts.sms.kinds[kind], true, `sms kind ${kind}`);
  }

  const evaluated = evaluateCatalogFacts(facts);
  assert.equal(evaluated.schema_contract.ok, true);
  assert.equal(evaluated.rpc_grants.ok, true);
  assert.equal(evaluated.patients_realtime_absent.ok, true);
  assert.equal(evaluated.sms_ledger.ok, true);
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

test("probe output contains no PHI-looking fields", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await admin.query(
    `select public.readiness_catalog_probe()::text as raw`,
  );
  const raw = rows[0].raw;
  assert.ok(!/phone_normalized|full_name_normalized|@/.test(raw));
  assert.ok(!/postgres:\/\//.test(raw));
  assert.ok(!/[0-9a-f]{32}/.test(raw));
});
