/**
 * #68 — Operations readiness & DB drift verification.
 * Pure readiness contract checks. Live Postgres checks are isolated in
 * ops-readiness.db.test.mjs so the unit gate never reports skipped DB tests.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_MIGRATION_HEAD,
  GRANT_EXPECTATIONS,
  REQUIRED_COLUMNS,
  REQUIRED_FUNCTIONS,
  REQUIRED_INVARIANTS,
  REQUIRED_TABLES,
  SMS_DELIVERY_KINDS,
  SMS_DELIVERY_STATES,
} from "../src/lib/readiness-contract.ts";
import { evaluateCatalogFacts } from "../src/lib/readiness.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

test("evaluateCatalogFacts fails closed on missing critical column", () => {
  const facts = {
    tables: Object.fromEntries(REQUIRED_TABLES.map((t) => [t, true])),
    columns: Object.fromEntries(
      Object.entries(REQUIRED_COLUMNS).flatMap(([table, cols]) =>
        cols.map((c) => [`${table}.${c}`, true]),
      ),
    ),
    functions: Object.fromEntries(REQUIRED_FUNCTIONS.map((f) => [f, true])),
    invariants: Object.fromEntries(REQUIRED_INVARIANTS.map((name) => [name, true])),
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
