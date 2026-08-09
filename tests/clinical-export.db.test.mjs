import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
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
    "select to_regprocedure('public.admin_clinical_export(uuid,text,boolean)') is not null as ok",
  );
  assert.equal(
    rows[0]?.ok,
    true,
    "admin_clinical_export is missing — apply migration 20260809120000 (do not skip)",
  );
  dbAvailable = true;
});

test.after(async () => {
  await client?.end().catch(() => {});
});

function requireDb(t) {
  if (!dbAvailable) {
    assert.fail(
      "Database unavailable — clinical export DB tests must not be skipped",
    );
  }
}

async function profile(role) {
  const id = randomUUID();
  const email = `export-${role}-${id.slice(0, 8)}@test.local`;
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
    [id, role, `Export ${role}`, email],
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

test("export includes seen untranscribed patients and applies latest clinical correction", async (t) => {
  requireDb(t);
  await client.query("begin");
  try {
    const operator = await profile("clinical_operator");
    const admin = await profile("admin");
    const campId = randomUUID();
    const dayId = randomUUID();
    const transcribedId = randomUUID();
    const untranscribedId = randomUUID();

    await client.query("update public.camps set is_active=false where is_active");
    await client.query(
      `insert into public.camps(
        id,name,venue,is_active,spectacles_collection_date,
        spectacles_collection_venue,post_camp_surgery_date,post_camp_surgery_venue
      ) values($1,'Export Camp','Venue',true,'2099-09-01','Specs Hall','2099-09-02','OT Hall')`,
      [campId],
    );
    await client.query(
      "insert into public.camp_days(id,camp_id,day_date,seat_limit) values($1,$2,'2099-08-01',20)",
      [dayId, campId],
    );
    await client.query(
      `insert into public.patients(
        id,camp_id,camp_day_id,full_name,age,gender,phone,address,queue_status,seen_at
      ) values
        ($1,$3,$4,'Transcribed Patient',50,'M','9876543210','Addr 1','seen',now()),
        ($2,$3,$4,'Untranscribed Patient',40,'F','9123456780','Addr 2','seen',now())`,
      [transcribedId, untranscribedId, campId, dayId],
    );

    await asUser(
      operator,
      "select public.clinical_save_transcription($1,$2::jsonb)",
      [
        transcribedId,
        JSON.stringify({
          diagnoses: { options: ["REFRACTION"], other: null },
          medicines: "Drops",
          remarks: "original",
        }),
      ],
    );

    const { rows: txRows } = await client.query(
      "select id from public.prescription_transcriptions where patient_id=$1",
      [transcribedId],
    );
    const transcriptionId = txRows[0].id;

    // Lock via fulfilment, then append a clinical correction (latest wins on export).
    await asUser(
      operator,
      "select public.clinical_resolve_item($1,'medicine','fulfilled')",
      [transcribedId],
    );
    await asUser(
      operator,
      "select public.clinical_add_correction($1,$2::jsonb,$3)",
      [
        transcribedId,
        JSON.stringify({
          diagnoses: { options: ["CATARACT"], other: null },
          medicines: "Drops",
          remarks: "corrected",
        }),
        "Fix diagnosis",
      ],
    );

    const { rows } = await asUser(
      admin,
      "select public.admin_clinical_export($1,'records',false) as payload",
      [campId],
    );
    const payload = rows[0].payload;
    assert.equal(payload.camp_name, "Export Camp");
    const exportRows = payload.rows;
    assert.ok(Array.isArray(exportRows));
    assert.ok(
      exportRows.some((row) => row.patient_name === "Untranscribed Patient" && row.data == null),
      "seen untranscribed patient must appear with blank clinical data",
    );
    const transcribed = exportRows.find(
      (row) => row.patient_name === "Transcribed Patient",
    );
    assert.ok(transcribed);
    assert.equal(transcribed.data?.remarks, "corrected");
    assert.deepEqual(transcribed.data?.diagnoses?.options, ["CATARACT"]);

    // Camp scoping: second camp should not appear
    const otherCamp = randomUUID();
    await client.query(
      `insert into public.camps(
        id,name,venue,is_active,spectacles_collection_date,
        spectacles_collection_venue,post_camp_surgery_date,post_camp_surgery_venue
      ) values($1,'Other Camp','Venue',false,'2099-09-01','Specs Hall','2099-09-02','OT Hall')`,
      [otherCamp],
    );
    const { rows: scoped } = await asUser(
      admin,
      "select public.admin_clinical_export($1,'records',false) as payload",
      [campId],
    );
    assert.ok(
      !scoped[0].payload.rows.some((row) => row.camp_name === "Other Camp"),
    );

    // Archived filter
    await client.query(
      "update public.prescription_transcriptions set archived_at=now() where id=$1",
      [transcriptionId],
    );
    const { rows: withoutArchived } = await asUser(
      admin,
      "select public.admin_clinical_export($1,'records',false) as payload",
      [campId],
    );
    assert.ok(
      withoutArchived[0].payload.rows.every(
        (row) => row.patient_name !== "Transcribed Patient" || row.data == null,
      ),
    );
    const { rows: withArchived } = await asUser(
      admin,
      "select public.admin_clinical_export($1,'records',true) as payload",
      [campId],
    );
    assert.ok(
      withArchived[0].payload.rows.some(
        (row) => row.patient_name === "Transcribed Patient" && row.data != null,
      ),
    );

    // No active camp + null camp id errors
    await client.query("update public.camps set is_active=false");
    await assert.rejects(
      asUser(admin, "select public.admin_clinical_export(null,'records',false)"),
      /no camp selected or active/i,
    );
  } finally {
    await client.query("rollback");
  }
});

test("medicine not_available requires unavailable medicines list", async (t) => {
  requireDb(t);
  await client.query("begin");
  try {
    const operator = await profile("clinical_operator");
    const campId = randomUUID();
    const dayId = randomUUID();
    const patientId = randomUUID();
    await client.query("update public.camps set is_active=false where is_active");
    await client.query(
      `insert into public.camps(
        id,name,venue,is_active,spectacles_collection_date,
        spectacles_collection_venue,post_camp_surgery_date,post_camp_surgery_venue
      ) values($1,'Med Camp','Venue',true,'2099-09-01','Specs Hall','2099-09-02','OT Hall')`,
      [campId],
    );
    await client.query(
      "insert into public.camp_days(id,camp_id,day_date,seat_limit) values($1,$2,'2099-08-01',20)",
      [dayId, campId],
    );
    await client.query(
      `insert into public.patients(
        id,camp_id,camp_day_id,full_name,age,gender,phone,queue_status,seen_at
      ) values($1,$2,$3,'Med Patient',45,'F','9876501234','seen',now())`,
      [patientId, campId, dayId],
    );
    await asUser(
      operator,
      "select public.clinical_save_transcription($1,$2::jsonb)",
      [
        patientId,
        JSON.stringify({
          diagnoses: { options: ["MEDICINE"], other: null },
          medicines: "Lubricant; Antibiotic",
        }),
      ],
    );
    await client.query("savepoint no_meds");
    await assert.rejects(
      asUser(
        operator,
        "select public.clinical_resolve_item($1,'medicine','not_available')",
        [patientId],
      ),
      /unavailable medicines/i,
    );
    await client.query("rollback to savepoint no_meds");
    await client.query("reset role");
    await asUser(
      operator,
      "select public.clinical_resolve_item($1,'medicine','not_available',$2::text[])",
      [patientId, ["Lubricant", "Antibiotic"]],
    );
    const { rows } = await client.query(
      `select unavailable_medicines from public.fulfilment_items i
       join public.prescription_transcriptions t on t.id=i.transcription_id
       where t.patient_id=$1 and i.kind='medicine'`,
      [patientId],
    );
    assert.deepEqual(rows[0].unavailable_medicines, ["Lubricant", "Antibiotic"]);
  } finally {
    await client.query("rollback");
  }
});
