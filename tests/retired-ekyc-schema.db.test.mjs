import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

test("retired eKYC storage and RPC inputs are absent", async () => {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rows: columns } = await client.query(
      `select column_name
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'patients'
         and column_name = any($1::text[])
       order by column_name`,
      [["aadhaar_hash", "aadhaar_kyc_ref", "aadhaar_verified_at"]],
    );
    assert.deepEqual(columns, []);

    const { rows: functions } = await client.query(
      `select
         p.pronargs,
         pg_get_function_arguments(p.oid) as arguments
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname = 'register_patient_idempotent'
       order by p.pronargs`,
    );

    assert.deepEqual(
      functions.map(({ pronargs }) => Number(pronargs)),
      [19],
      "only the canonical 19-arg RPC may remain",
    );
    for (const fn of functions) {
      assert.doesNotMatch(
        fn.arguments,
        /aadhaar_hash|aadhaar_verified_at|aadhaar_kyc_ref/i,
      );
    }

    const { rows: constraints } = await client.query(
      `select pg_get_constraintdef(oid) as definition
       from pg_constraint
       where conrelid = 'public.patients'::regclass
         and conname = 'patients_provenance_check'`,
    );
    assert.equal(constraints.length, 1);
    assert.match(constraints[0].definition, /card_scanned/);
    assert.match(constraints[0].definition, /self_declared/);
    assert.doesNotMatch(constraints[0].definition, /card_verified/);
    assert.doesNotMatch(constraints[0].definition, /ekyc_verified/);

    const { rows: phoneColumns } = await client.query(
      `select is_nullable, column_default
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'patients'
         and column_name = 'phone_provenance'`,
    );
    assert.equal(phoneColumns.length, 1);
    assert.equal(phoneColumns[0].is_nullable, "NO");
    assert.match(phoneColumns[0].column_default, /self_declared/);

    const { rows: phoneConstraints } = await client.query(
      `select pg_get_constraintdef(oid) as definition
       from pg_constraint
       where conrelid = 'public.patients'::regclass
         and conname = 'patients_phone_provenance_check'`,
    );
    assert.equal(phoneConstraints.length, 1);
    assert.match(phoneConstraints[0].definition, /self_declared/);
  } finally {
    await client.end();
  }
});
