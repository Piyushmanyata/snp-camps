/**
 * Ticket #95 — Theatre overflow to next camp day unit test suite.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  EXPECTED_MIGRATION_HEAD,
  REQUIRED_TABLES,
  REQUIRED_COLUMNS,
} from "../src/lib/readiness-contract.ts";
import { doctorSubmitPrescriptionWithRetries } from "../src/lib/desk-ops.ts";

describe("OT Overflow readiness contract & desk-ops unit tests", () => {
  test("EXPECTED_MIGRATION_HEAD is updated to 20260727200000", () => {
    assert.equal(EXPECTED_MIGRATION_HEAD, "20260727200000");
  });

  test("readiness contract includes treatment_orders and scheduled_camp_day_id", () => {
    assert.ok(REQUIRED_TABLES.includes("treatment_orders"));
    assert.ok(REQUIRED_COLUMNS.treatment_orders?.includes("scheduled_camp_day_id"));
  });

  test("doctorSubmitPrescriptionWithRetries handles scheduled date and capacity refusal error", async () => {
    // 1. Success with scheduled day date
    const mockSuccessRpc = async () => ({
      data: [{
        prescription_id: "rx-123",
        patient_id: "pat-123",
        reg_no: 101,
        queue_status: "seen",
        created_orders_count: 1,
        scheduled_camp_day_id: "day-456",
        scheduled_day_date: "2099-05-02",
      }],
      error: null,
    });

    const res1 = await doctorSubmitPrescriptionWithRetries({
      patientId: "pat-123",
      destinations: ["ot"],
      rpc: mockSuccessRpc,
    });

    assert.ok(res1.ok);
    if (res1.ok) {
      assert.equal(res1.row.scheduled_camp_day_id, "day-456");
      assert.equal(res1.row.scheduled_day_date, "2099-05-02");
    }

    // 2. Failure when no capacity remaining
    const mockRefusalRpc = async () => ({
      data: null,
      error: {
        message: "Camp has no theatre capacity remaining",
        code: "P0001",
      },
    });

    const res2 = await doctorSubmitPrescriptionWithRetries({
      patientId: "pat-123",
      destinations: ["ot"],
      rpc: mockRefusalRpc,
    });

    assert.equal(res2.ok, false);
    if (!res2.ok) {
      assert.match(res2.error, /Camp has no theatre capacity remaining/i);
    }
  });
});
