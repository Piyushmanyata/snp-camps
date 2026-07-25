/**
 * Behavioural coverage for POST /api/patient-account (#17).
 * Double provision, concurrent provision, pre-existing Auth, doctor denied,
 * patient-self allowed. Asserts no auth.admin.deleteUser on provision paths.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../src/app/api/patient-account/route.ts";
import {
  __resetAuthMock,
  __setAuthMock,
} from "./stubs/supabase-ssr.mjs";
import {
  __resetServiceRoleClient,
  __setServiceRoleClient,
} from "./stubs/service-role-admin.mjs";
import { __resetCookies } from "./stubs/next-headers.mjs";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_ID = "22222222-2222-4222-8222-222222222222";
const DOCTOR_ID = "33333333-3333-4333-8333-333333333333";
const PATIENT_USER_ID = "44444444-4444-4444-8444-444444444444";
const REG_NO = 1001;
const EMAIL = `reg${REG_NO}@patients.snp.local`;

function clearRateLimits() {
  globalThis.__snpRateLimits?.clear();
}

function accountRequest(body, ip = "203.0.113.40") {
  return new Request("http://127.0.0.1/api/patient-account", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

function sessionAs(role, userId) {
  __resetCookies([{ name: "sb-test-auth-token", value: "1" }]);
  __setAuthMock({
    userId,
    profile: {
      id: userId,
      role,
      full_name: role,
      phone: null,
      email: `${role}@test.local`,
      disabled_at: null,
    },
  });
}

/**
 * In-memory service-role fake with conditional user_id link semantics.
 */
function createFakeAdmin(initial = {}) {
  const state = {
    patient: {
      id: PATIENT_ID,
      reg_no: REG_NO,
      full_name: "Walk In",
      user_id: null,
      phone: "9876543210",
      passcode_issued_at: null,
      ...initial.patient,
    },
    usersByEmail: new Map(initial.usersByEmail || []),
    usersById: new Map(initial.usersById || []),
    profilesByEmail: new Map(initial.profilesByEmail || []),
    deleteUserCalls: [],
    createUserCalls: 0,
    linkAttempts: 0,
    /** Delay first link so concurrent second request can race. */
    holdFirstLinkMs: initial.holdFirstLinkMs ?? 0,
    linkHolders: 0,
  };

  for (const [email, user] of state.usersByEmail) {
    state.usersById.set(user.id, { ...user, email });
  }

  const admin = {
    auth: {
      admin: {
        async createUser({ email, password, user_metadata }) {
          state.createUserCalls += 1;
          if (state.usersByEmail.has(email.toLowerCase())) {
            return {
              data: { user: null },
              error: { message: "User already registered" },
            };
          }
          const id = `user-${state.createUserCalls}-${Math.random().toString(16).slice(2, 8)}`;
          const user = {
            id,
            email,
            password,
            phone: null,
            user_metadata,
          };
          state.usersByEmail.set(email.toLowerCase(), user);
          state.usersById.set(id, user);
          return { data: { user: { id } }, error: null };
        },
        async updateUserById(id, attrs) {
          const user = state.usersById.get(id);
          if (!user) {
            return { data: null, error: { message: "not found" } };
          }
          if (attrs.password) user.password = attrs.password;
          if (attrs.email) {
            user.email = attrs.email;
            state.usersByEmail.set(attrs.email.toLowerCase(), user);
          }
          return { data: { user }, error: null };
        },
        async getUserById(id) {
          const user = state.usersById.get(id);
          if (!user) {
            return { data: { user: null }, error: { message: "not found" } };
          }
          return {
            data: {
              user: {
                id: user.id,
                email: user.email,
                phone: user.phone,
              },
            },
            error: null,
          };
        },
        async listUsers() {
          return {
            data: {
              users: [...state.usersById.values()].map((u) => ({
                id: u.id,
                email: u.email,
              })),
            },
            error: null,
          };
        },
        async deleteUser(id) {
          state.deleteUserCalls.push(id);
          state.usersById.delete(id);
          for (const [email, user] of state.usersByEmail) {
            if (user.id === id) state.usersByEmail.delete(email);
          }
          return { data: null, error: null };
        },
      },
    },
    from(table) {
      if (table === "patients") {
        return {
          select() {
            return {
              eq(col, val) {
                return {
                  async maybeSingle() {
                    if (col === "id" && val === state.patient.id) {
                      return { data: { ...state.patient }, error: null };
                    }
                    return { data: null, error: null };
                  },
                };
              },
            };
          },
          update(values) {
            const filters = { eq: {}, is: {} };
            const chain = {
              eq(col, val) {
                filters.eq[col] = val;
                return chain;
              },
              is(col, val) {
                filters.is[col] = val;
                return chain;
              },
              select() {
                return {
                  maybeSingle: () => chain._run(true),
                };
              },
              then(resolve, reject) {
                return chain._run(false).then(resolve, reject);
              },
              async _run(withSelect) {
                state.linkAttempts += 1;
                if (
                  state.holdFirstLinkMs > 0 &&
                  state.linkHolders === 0 &&
                  values.user_id != null
                ) {
                  state.linkHolders += 1;
                  await new Promise((r) =>
                    setTimeout(r, state.holdFirstLinkMs),
                  );
                }

                if (filters.eq.id && filters.eq.id !== state.patient.id) {
                  return withSelect
                    ? { data: null, error: null }
                    : { data: null, error: null };
                }
                if (
                  Object.prototype.hasOwnProperty.call(filters.is, "user_id") &&
                  filters.is.user_id === null &&
                  state.patient.user_id != null
                ) {
                  return { data: null, error: null };
                }
                Object.assign(state.patient, values);
                const data = { ...state.patient };
                return { data, error: null };
              },
            };
            return chain;
          },
        };
      }
      if (table === "profiles") {
        return {
          select() {
            return {
              eq(col, val) {
                return {
                  async maybeSingle() {
                    if (col === "email") {
                      const row = state.profilesByEmail.get(
                        String(val).toLowerCase(),
                      );
                      return { data: row ?? null, error: null };
                    }
                    return { data: null, error: null };
                  },
                };
              },
            };
          },
          async upsert(row) {
            state.profilesByEmail.set(String(row.email).toLowerCase(), {
              id: row.id,
              role: row.role,
              full_name: row.full_name,
              email: row.email,
            });
            return { error: null };
          },
          update(values) {
            return {
              eq() {
                return Promise.resolve({ data: values, error: null });
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    __state: state,
  };

  return admin;
}

test.beforeEach(() => {
  clearRateLimits();
  __resetAuthMock();
  __resetServiceRoleClient();
  __resetCookies();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
});

test("double provision yields one Auth user, one link, two successes", async () => {
  const fake = createFakeAdmin();
  __setServiceRoleClient(fake);
  sessionAs("volunteer", STAFF_ID);

  const body = {
    patientId: PATIENT_ID,
    regNo: REG_NO,
    adminProvision: true,
  };

  const first = await POST(accountRequest(body, "203.0.113.41"));
  const second = await POST(accountRequest(body, "203.0.113.42"));
  const b1 = await first.json();
  const b2 = await second.json();

  assert.equal(first.status, 200, JSON.stringify(b1));
  assert.equal(second.status, 200, JSON.stringify(b2));
  assert.equal(b1.ok, true);
  assert.equal(b2.ok, true);
  assert.equal(b1.userId, b2.userId);
  assert.equal("password" in b1, false);
  assert.equal("password" in b2, false);
  assert.equal(fake.__state.usersById.size, 1);
  assert.equal(fake.__state.patient.user_id, b1.userId);
  assert.equal(fake.__state.deleteUserCalls.length, 0);
});

test("concurrent provision: one Auth user, one link, no deleteUser", async () => {
  const fake = createFakeAdmin({ holdFirstLinkMs: 40 });
  __setServiceRoleClient(fake);
  sessionAs("admin", STAFF_ID);

  const body = {
    patientId: PATIENT_ID,
    regNo: REG_NO,
    adminProvision: true,
  };

  const [r1, r2] = await Promise.all([
    POST(accountRequest(body, "203.0.113.51")),
    POST(accountRequest(body, "203.0.113.52")),
  ]);
  const b1 = await r1.json();
  const b2 = await r2.json();

  assert.equal(r1.status, 200, JSON.stringify(b1));
  assert.equal(r2.status, 200, JSON.stringify(b2));
  assert.equal(b1.userId, fake.__state.patient.user_id);
  assert.equal(b2.userId, fake.__state.patient.user_id);
  // Deterministic email → at most one Auth user even under race.
  assert.equal(fake.__state.usersById.size, 1);
  assert.ok(fake.__state.patient.user_id);
  assert.equal(fake.__state.deleteUserCalls.length, 0);
});

test("pre-existing Auth user is linked as success, not an error", async () => {
  const existingId = "55555555-5555-4555-8555-555555555555";
  const fake = createFakeAdmin({
    usersByEmail: [
      [
        EMAIL.toLowerCase(),
        { id: existingId, email: EMAIL, password: "OLD", phone: null },
      ],
    ],
    profilesByEmail: [
      [EMAIL.toLowerCase(), { id: existingId, role: "patient", email: EMAIL }],
    ],
  });
  __setServiceRoleClient(fake);
  sessionAs("volunteer", STAFF_ID);

  const res = await POST(
    accountRequest({
      patientId: PATIENT_ID,
      regNo: REG_NO,
      adminProvision: true,
    }),
  );
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.userId, existingId);
  assert.equal(fake.__state.patient.user_id, existingId);
  assert.equal(fake.__state.deleteUserCalls.length, 0);
  assert.equal("password" in body, false);
});

test("doctor is denied provision and issue", async () => {
  const fake = createFakeAdmin();
  __setServiceRoleClient(fake);
  sessionAs("doctor", DOCTOR_ID);

  const provision = await POST(
    accountRequest(
      {
        patientId: PATIENT_ID,
        regNo: REG_NO,
        adminProvision: true,
      },
      "203.0.113.61",
    ),
  );
  assert.equal(provision.status, 403);

  // Linked patient — doctor still cannot reissue.
  fake.__state.patient.user_id = PATIENT_USER_ID;
  fake.__state.usersById.set(PATIENT_USER_ID, {
    id: PATIENT_USER_ID,
    email: EMAIL,
    password: "x",
    phone: null,
  });

  const issue = await POST(
    accountRequest(
      {
        patientId: PATIENT_ID,
        regNo: REG_NO,
        returnCredentials: true,
      },
      "203.0.113.62",
    ),
  );
  assert.equal(issue.status, 403);
  assert.equal(fake.__state.deleteUserCalls.length, 0);
});

test("patient self may reset own password", async () => {
  const fake = createFakeAdmin({
    patient: {
      id: PATIENT_ID,
      reg_no: REG_NO,
      full_name: "Self",
      user_id: PATIENT_USER_ID,
      phone: null,
      passcode_issued_at: null,
    },
  });
  fake.__state.usersById.set(PATIENT_USER_ID, {
    id: PATIENT_USER_ID,
    email: EMAIL,
    password: "OLDSECRET12",
    phone: null,
  });
  __setServiceRoleClient(fake);
  sessionAs("patient", PATIENT_USER_ID);

  const res = await POST(
    accountRequest({
      patientId: PATIENT_ID,
      regNo: REG_NO,
      password: "NEWSECRET99",
    }),
  );
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(fake.__state.usersById.get(PATIENT_USER_ID).password, "NEWSECRET99");
  assert.ok(fake.__state.patient.passcode_issued_at);
  // Self-reset without returnCredentials must not echo the password.
  assert.equal("password" in body, false);
});

test("staff provision + issue returns passcode once and stamps issued_at", async () => {
  const fake = createFakeAdmin();
  __setServiceRoleClient(fake);
  sessionAs("admin", STAFF_ID);

  const res = await POST(
    accountRequest({
      patientId: PATIENT_ID,
      regNo: REG_NO,
      adminProvision: true,
      returnCredentials: true,
    }),
  );
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(typeof body.password, "string");
  assert.ok(body.password.length >= 6);
  assert.ok(fake.__state.patient.user_id);
  assert.ok(fake.__state.patient.passcode_issued_at);
  assert.equal(fake.__state.deleteUserCalls.length, 0);
});

test("source: patient-account route never calls deleteUser", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/patient-account/route.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /deleteUser/);
  const ops = fs.readFileSync(
    path.join(process.cwd(), "src/lib/patient-account-ops.ts"),
    "utf8",
  );
  assert.doesNotMatch(ops, /deleteUser/);
  assert.doesNotMatch(ops, /account_provisioning_token/);
  assert.doesNotMatch(source, /account_provisioning_token/);
});
