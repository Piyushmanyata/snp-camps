/**
 * Behavioural coverage for getDoctorsList (#24).
 * Service-role only — no session/RLS fallback that silently empties the picker.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DOCTOR_LIST_UNAVAILABLE,
  getDoctorsList,
} from "../src/lib/metadata.ts";
import {
  __resetServiceRoleClient,
  __setServiceRoleClient,
} from "./stubs/service-role-admin.mjs";

const DOCTORS = [
  { id: "doc-1", full_name: "Dr One" },
  { id: "doc-2", full_name: "Dr Two" },
];

function mockDoctorsClient({ data = DOCTORS, error = null } = {}) {
  return {
    from(table) {
      assert.equal(table, "profiles");
      const chain = {
        select() {
          return chain;
        },
        eq(col, val) {
          assert.equal(col, "role");
          assert.equal(val, "doctor");
          return chain;
        },
        is(col, val) {
          assert.equal(col, "disabled_at");
          assert.equal(val, null);
          return chain;
        },
        order(col, opts) {
          assert.equal(col, "full_name");
          assert.equal(opts?.ascending, true);
          return Promise.resolve({ data: error ? null : data, error });
        },
      };
      return chain;
    },
  };
}

test.afterEach(() => {
  __resetServiceRoleClient();
});

test("getDoctorsList: service-role present and query succeeds", async () => {
  const prev = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  __setServiceRoleClient(mockDoctorsClient({ data: DOCTORS }));

  try {
    const list = await getDoctorsList();
    assert.deepEqual(list, DOCTORS);
  } finally {
    if (prev === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prev;
  }
});

test("getDoctorsList: service-role present and query errors throws", async () => {
  const prev = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  __setServiceRoleClient(
    mockDoctorsClient({ error: { message: "permission denied", code: "42501" } }),
  );

  try {
    await assert.rejects(
      () => getDoctorsList(),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, DOCTOR_LIST_UNAVAILABLE);
        return true;
      },
    );
  } finally {
    if (prev === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prev;
  }
});

test("getDoctorsList: service-role key absent throws", async () => {
  const prev = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Even if a client were installed, missing env must throw first.
  __setServiceRoleClient(mockDoctorsClient({ data: DOCTORS }));

  try {
    await assert.rejects(
      () => getDoctorsList(),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, DOCTOR_LIST_UNAVAILABLE);
        return true;
      },
    );
  } finally {
    if (prev === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prev;
  }
});

test("getDoctorsList: empty result is success (not an error)", async () => {
  const prev = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  __setServiceRoleClient(mockDoctorsClient({ data: [] }));

  try {
    const list = await getDoctorsList();
    assert.deepEqual(list, []);
  } finally {
    if (prev === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prev;
  }
});
