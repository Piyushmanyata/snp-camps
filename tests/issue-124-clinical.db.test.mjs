import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

let client;
let dbAvailable = false;

test.before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
  } catch {
    dbAvailable = false;
    return;
  }
  const { rows } = await client.query(
    "select to_regprocedure('public.clinical_lookup(uuid,integer)') is not null as ok",
  );
  assert.equal(rows[0]?.ok, true, "clinical workflow migration is missing");
  dbAvailable = true;
});

test.after(async () => {
  await client?.end().catch(() => {});
});

function skipIfNoDb(t) {
  if (!dbAvailable) {
    t.skip("local clinical workflow migration unavailable");
    return true;
  }
  return false;
}

async function profile(role) {
  const id = randomUUID();
  const email = `clinical-${role}-${id.slice(0, 8)}@test.local`;
  await client.query(
    `insert into auth.users (
      id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
      raw_app_meta_data,raw_user_meta_data,created_at,updated_at
    ) values (
      $1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
      $2,crypt('test-password-long',gen_salt('bf')),now(),
      '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()
    )`,
    [id, email],
  );
  await client.query(
    "insert into public.profiles(id,role,full_name,email) values($1,$2::public.user_role,$3,$4)",
    [id, role, `Clinical ${role}`, email],
  );
  return id;
}

async function asUser(userId, sql, params = []) {
  await client.query("set local role authenticated");
  await client.query("select set_config('request.jwt.claims',$1,true)", [
    JSON.stringify({ sub: userId, role: "authenticated" }),
  ]);
  const result = await client.query(sql, params);
  await client.query("reset role");
  return result;
}

test("clinical workflow is seen-only, locked, audited, and follow-up capable", async (t) => {
  if (skipIfNoDb(t)) return;
  await client.query("begin");
  try {
    const operator = await profile("clinical_operator");
    const admin = await profile("admin");
    const volunteer = await profile("volunteer");
    const campId = randomUUID();
    const dayId = randomUUID();
    const patientId = randomUUID();
    await client.query("update public.camps set is_active=false where is_active");
    await client.query(
      `insert into public.camps(
        id,name,venue,is_active,spectacles_collection_date,
        spectacles_collection_venue,post_camp_surgery_date,post_camp_surgery_venue
      ) values($1,'Clinical Contract','Venue',true,'2099-09-01','Specs Hall','2099-09-02','OT Hall')`,
      [campId],
    );
    await client.query(
      "insert into public.camp_days(id,camp_id,day_date,seat_limit) values($1,$2,'2099-08-01',20)",
      [dayId, campId],
    );
    await client.query(
      `insert into public.patients(
        id,camp_id,camp_day_id,full_name,age,gender,phone,queue_status,seen_at
      ) values($1,$2,$3,'Seen Patient',52,'F','9876543210','seen',now())`,
      [patientId, campId, dayId],
    );

    await client.query("savepoint invalid_clinical");
    await assert.rejects(
      asUser(
        operator,
        "select public.clinical_save_transcription($1,$2::jsonb)",
        [patientId, JSON.stringify({ diagnoses: ["Other"], bloodSugar: "2000" })],
      ),
      /blood sugar/i,
    );
    await client.query("rollback to savepoint invalid_clinical");
    await client.query("reset role");

    await asUser(
      operator,
      `select public.clinical_save_transcription($1,$2::jsonb)`,
      [
        patientId,
        JSON.stringify({
          diagnoses: ["Other"],
          remarks: "Paper remains prescribing source",
          specs: {
            type: "distance",
            right: { sphere: "-1.0" },
            left: { sphere: "-1.5" },
            pd: "62",
          },
        }),
      ],
    );
    await client.query("savepoint missing_item_detail");
    await assert.rejects(
      asUser(
        operator,
        "select public.clinical_resolve_item($1,'medicine','fulfilled')",
        [patientId],
      ),
      /medicine detail/i,
    );
    await client.query("rollback to savepoint missing_item_detail");
    await client.query("reset role");
    const { rows: resolved } = await asUser(
      operator,
      "select public.clinical_resolve_item($1,'specs','deferred') as result",
      [patientId],
    );
    const itemId = resolved[0].result.item.id;
    const slipId = resolved[0].result.slip.id;
    assert.ok(slipId);

    await client.query("savepoint locked_edit");
    await assert.rejects(
      asUser(
        operator,
        "select public.clinical_save_transcription($1,$2::jsonb)",
        [patientId, JSON.stringify({ diagnoses: ["Changed"] })],
      ),
      /locked/i,
    );
    await client.query("rollback to savepoint locked_edit");
    await client.query("reset role");
    const { rows: corrections } = await asUser(
      operator,
      "select (public.clinical_add_correction($1,$2::jsonb,$3)).id",
      [patientId, JSON.stringify({ diagnoses: ["Corrected"] }), "Paper reread"],
    );
    assert.ok(corrections[0].id);
    const { rows: effective } = await asUser(
      operator,
      "select public.clinical_lookup($1,null) as record",
      [patientId],
    );
    assert.deepEqual(effective[0].record.effective_data.diagnoses, ["Corrected"]);

    await client.query("savepoint current_camp_followup");
    await assert.rejects(
      asUser(operator, "select public.clinical_followup_fulfil($1)", [itemId]),
      /not unresolved/i,
    );
    await client.query("rollback to savepoint current_camp_followup");
    await client.query("reset role");
    await client.query("update public.camps set is_active=false where id=$1", [campId]);
    await client.query("savepoint historical_edit");
    await assert.rejects(
      asUser(operator, "select public.clinical_lookup($1,null)", [patientId]),
      /registration not found/i,
    );
    await client.query("rollback to savepoint historical_edit");
    await client.query("reset role");
    await client.query("savepoint historical_correction");
    await assert.rejects(
      asUser(
        operator,
        "select public.clinical_add_correction($1,$2::jsonb,$3)",
        [patientId, JSON.stringify({ diagnoses: ["Late change"] }), "Late edit"],
      ),
      /locked transcription not found/i,
    );
    await client.query("rollback to savepoint historical_correction");
    await client.query("reset role");
    await asUser(operator, "select public.clinical_followup_fulfil($1)", [itemId]);
    await asUser(admin, "select public.admin_reverse_fulfilment($1,$2)", [
      itemId,
      "Fulfilment marked against wrong patient",
    ]);
    const { rows: state } = await client.query(
      `select i.outcome,s.status from public.fulfilment_items i
       join public.deferred_slips s on s.item_id=i.id
       where i.id=$1 and s.id=$2`,
      [itemId, slipId],
    );
    assert.deepEqual(state[0], { outcome: "deferred", status: "active" });
    const { rows: adminRecords } = await asUser(
      admin,
      "select public.admin_clinical_records(true) as records",
    );
    const reviewed = adminRecords[0].records.find(
      (record) => record.patient_id === patientId,
    );
    assert.deepEqual(reviewed.data.diagnoses, ["Corrected"]);
    assert.equal(reviewed.corrections[0].reason, "Paper reread");
    assert.ok(reviewed.corrections[0].created_by);
    assert.ok(reviewed.corrections[0].created_at);
    assert.ok(reviewed.items[0].events.some((event) => event.event === "reversed"));
    assert.ok(reviewed.items[0].slips.some((slip) => slip.id === slipId));

    const validTemplate = {
      sections: [
        { key: "remarks", label: "Remarks", heightMm: 16, visible: true },
        { key: "medicines", label: "Medicines", heightMm: 26, visible: true },
      ],
      sponsorLogos: ["/brand/rupa-logo.png"],
      fitsOnePage: false,
    };
    await asUser(
      admin,
      "select public.admin_save_prescription_template($1,$2::jsonb,true)",
      [campId, JSON.stringify(validTemplate)],
    );
    await asUser(
      admin,
      "select public.admin_save_prescription_template($1,$2::jsonb,true)",
      [campId, JSON.stringify(validTemplate)],
    );
    const { rows: versions } = await client.query(
      `select status,count(*)::int as count
       from public.prescription_template_versions where camp_id=$1
       group by status order by status`,
      [campId],
    );
    assert.deepEqual(versions, [
      { status: "published", count: 1 },
      { status: "superseded", count: 1 },
    ]);
    await client.query("savepoint oversized_template");
    await assert.rejects(
      asUser(
        admin,
        "select public.admin_save_prescription_template($1,$2::jsonb,true)",
        [
          campId,
          JSON.stringify({
            ...validTemplate,
            sections: validTemplate.sections.map((section) => ({
              ...section,
              heightMm: 32,
            })),
            fitsOnePage: true,
          }),
        ],
      ),
      /oversized/i,
    );
    await client.query("rollback to savepoint oversized_template");
    await client.query("reset role");

    await client.query("savepoint denied");
    await assert.rejects(
      asUser(volunteer, "select public.clinical_lookup($1,null)", [patientId]),
      /clinical desk only/i,
    );
    await client.query("rollback to savepoint denied");
    await client.query("reset role");
  } finally {
    await client.query("rollback");
  }
});

test("clinical tables deny authenticated direct access", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await client.query(
    `select count(*)::int as grants
     from information_schema.role_table_grants
     where grantee='authenticated' and table_schema='public'
       and table_name in (
         'prescription_transcriptions','prescription_corrections',
         'fulfilment_items','fulfilment_events','deferred_slips'
       )`,
  );
  assert.equal(rows[0].grants, 0);
});
