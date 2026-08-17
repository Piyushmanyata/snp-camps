import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const latest = path.join(
  root,
  "supabase",
  "migrations",
  "20260816240000_deferral_sms_kind.sql",
);

test("upsert_ot_schedule_day date path locks then counts; no unguarded ON CONFLICT", () => {
  const sql = fs.readFileSync(latest, "utf8");
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.upsert_ot_schedule_day/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /SEAT_LIMIT_BELOW_ASSIGNED/);
  assert.match(
    sql,
    /d\.camp_id = p_camp_id[\s\S]*d\.day_date = p_day_date[\s\S]*FOR UPDATE/,
  );
  assert.doesNotMatch(sql, /ON CONFLICT \(camp_id, day_date\) DO UPDATE/);
});

test("head probe reports OT catalogue, list RPC, and deferral SMS kinds", () => {
  const sql = fs.readFileSync(latest, "utf8");
  assert.match(sql, /readiness_catalog_probe/);
  assert.match(sql, /ot_schedule_days/);
  assert.match(sql, /fulfilment_items\.ot_schedule_day_id/);
  assert.match(sql, /upsert_ot_schedule_day/);
  assert.match(sql, /list_ot_schedule_days/);
  assert.match(sql, /spectacles_deferral/);
  assert.match(sql, /surgery_deferral_t1/);
});

test("head migration ADD VALUE covers every issue and T-1 delivery kind", () => {
  const sql = fs.readFileSync(latest, "utf8");
  for (const kind of [
    "spectacles_deferral",
    "surgery_deferral",
    "spectacles_deferral_t1",
    "surgery_deferral_t1",
  ]) {
    assert.match(
      sql,
      new RegExp(
        `ADD VALUE IF NOT EXISTS '${kind}'`,
      ),
      kind,
    );
  }
});
