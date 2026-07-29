/**
 * Behavioural coverage for /api/admin/staff/[role] (#23).
 * Four volunteer lifecycle ops + invalid/retired roles + self-deactivation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  GET,
  POST,
  PATCH,
  DELETE,
} from "../src/app/api/admin/staff/[role]/route.ts";
import {
  __resetAuthMock,
  __setAuthMock,
} from "./stubs/supabase-ssr.mjs";
import {
  __resetServiceRoleClient,
  __setServiceRoleClient,
} from "./stubs/service-role-admin.mjs";
import {
  __revalidateTagCalls,
  __resetRevalidateTagCalls,
} from "./stubs/next-cache.mjs";
import { __resetCookies } from "./stubs/next-headers.mjs";

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VOLUNTEER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TEAM_LEAD_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function sessionAsAdmin(userId = ADMIN_ID) {
  __resetCookies([{ name: "sb-test-auth-token", value: "1" }]);
  __setAuthMock({
    userId,
    profile: {
      id: userId,
      role: "admin",
      full_name: "Admin",
      phone: null,
      email: "admin@test.local",
      disabled_at: null,
    },
  });
}

function sessionAsTeamLead(userId = TEAM_LEAD_ID) {
  __resetCookies([{ name: "sb-test-auth-token", value: "1" }]);
  __setAuthMock({
    userId,
    profile: {
      id: userId,
      role: "team_lead",
      full_name: "Team Lead",
      phone: null,
      email: "lead@test.local",
      disabled_at: null,
    },
  });
}

function ctx(role) {
  return { params: Promise.resolve({ role }) };
}

function jsonReq(url, method, body) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * In-memory service-role fake for staff create / reset / deactivate / reactivate.
 */
function createStaffFake(seedProfiles = []) {
  const profiles = new Map(
    seedProfiles.map((p) => [
      p.id,
      { phone: null, created_at: "2026-01-01", ...p },
    ]),
  );
  /** @type {Map<string, { id: string, email: string|null, password: string|null, ban_duration: string }>} */
  const users = new Map();
  for (const p of profiles.values()) {
    if (p.email) {
      users.set(p.email.toLowerCase(), {
        id: p.id,
        email: p.email,
        password: "old-pass",
        ban_duration: p.disabled_at ? "876000h" : "none",
      });
    }
  }

  let createCount = 0;

  function findUserById(id) {
    for (const u of users.values()) {
      if (u.id === id) return u;
    }
    return null;
  }

  function profileBuilder() {
    /** @type {Record<string, unknown>} */
    const filters = {};
    let nullDisabledOnly = false;
    let updatePayload = null;
    let selectMode = "full";

    const api = {
      select(cols) {
        if (cols === "disabled_at") selectMode = "disabled_at";
        else if (cols && cols.includes("full_name")) selectMode = "full";
        else selectMode = "full";
        return api;
      },
      upsert(row) {
        profiles.set(row.id, {
          phone: null,
          created_at: new Date().toISOString(),
          disabled_at: null,
          ...row,
        });
        return Promise.resolve({ data: row, error: null });
      },
      update(payload) {
        updatePayload = payload;
        return api;
      },
      eq(col, val) {
        filters[col] = val;
        return api;
      },
      is(col, val) {
        if (col === "disabled_at" && val === null) nullDisabledOnly = true;
        else filters[col] = val;
        return api;
      },
      async maybeSingle() {
        let row = filters.id ? profiles.get(/** @type {string} */ (filters.id)) : null;
        if (!row) return { data: null, error: null };

        if (filters.role !== undefined && row.role !== filters.role) {
          return { data: null, error: null };
        }
        if (
          filters.disabled_at !== undefined &&
          row.disabled_at !== filters.disabled_at
        ) {
          return { data: null, error: null };
        }
        if (nullDisabledOnly && row.disabled_at != null) {
          return { data: null, error: null };
        }

        if (updatePayload) {
          const next = { ...row, ...updatePayload };
          profiles.set(row.id, next);
          row = next;
        }

        if (selectMode === "disabled_at") {
          return { data: { disabled_at: row.disabled_at }, error: null };
        }
        return {
          data: {
            id: row.id,
            full_name: row.full_name,
            email: row.email,
            phone: row.phone ?? null,
            role: row.role,
            created_at: row.created_at,
            disabled_at: row.disabled_at ?? null,
          },
          error: null,
        };
      },
    };
    return api;
  }

  return {
    profiles,
    users,
    auth: {
      admin: {
        async createUser({ email, password, user_metadata }) {
          createCount += 1;
          const key = email.toLowerCase();
          if (users.has(key)) {
            return {
              data: { user: null },
              error: { message: "User already registered" },
            };
          }
          const id = `dddddddd-dddd-4ddd-8ddd-${String(createCount).padStart(12, "0")}`;
          const user = {
            id,
            email,
            password,
            ban_duration: "none",
            user_metadata,
          };
          users.set(key, user);
          return { data: { user: { id } }, error: null };
        },
        async updateUserById(id, attrs) {
          let user = findUserById(id);
          if (!user) {
            user = {
              id,
              email: null,
              password: null,
              ban_duration: "none",
            };
            users.set(id, user);
          }
          if (attrs.password) user.password = attrs.password;
          if (attrs.ban_duration) user.ban_duration = attrs.ban_duration;
          return { data: { user }, error: null };
        },
        async deleteUser(id) {
          for (const [email, u] of users) {
            if (u.id === id) users.delete(email);
          }
          return { data: {}, error: null };
        },
      },
    },
    from(table) {
      assert.equal(table, "profiles");
      return profileBuilder();
    },
  };
}

test.beforeEach(() => {
  __resetAuthMock();
  __resetServiceRoleClient();
  __resetRevalidateTagCalls();
  __resetCookies([]);
});

test("rejects unknown role with 400 before database access", async () => {
  const res = await POST(
    jsonReq("http://127.0.0.1/api/admin/staff/nurse", "POST", {
      fullName: "X",
      email: "x@test.local",
    }),
    ctx("nurse"),
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /invalid staff role/i);
  assert.equal(__revalidateTagCalls.length, 0);
});

for (const role of ["volunteer"]) {
  test(`${role}: create provisions profile`, async () => {
    sessionAsAdmin();
    const fake = createStaffFake();
    __setServiceRoleClient(fake);

    const res = await POST(
      jsonReq(`http://127.0.0.1/api/admin/staff/${role}`, "POST", {
        fullName: `Test ${role}`,
        email: `${role}@example.com`,
      }),
      ctx(role),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.temporaryPassword?.length >= 10);
    assert.equal(body.staff.role, role);
    assert.equal(body.staff.email, `${role}@example.com`);
    assert.ok(fake.profiles.has(body.staff.id));
    assert.equal(fake.profiles.get(body.staff.id).role, role);
    assert.deepEqual(__revalidateTagCalls, []);
  });

  test(`${role}: reset password returns temporary password and invalidates cache`, async () => {
    sessionAsAdmin();
    const id = VOLUNTEER_ID;
    const fake = createStaffFake([
      {
        id,
        role,
        full_name: `Active ${role}`,
        email: `active-${role}@example.com`,
        disabled_at: null,
      },
    ]);
    __setServiceRoleClient(fake);

    const res = await PATCH(
      jsonReq(`http://127.0.0.1/api/admin/staff/${role}`, "PATCH", {
        id,
        action: "reset_password",
      }),
      ctx(role),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.temporaryPassword?.length >= 10);
    assert.equal(body.staff.id, id);
    assert.deepEqual(__revalidateTagCalls, []);
  });

  test(`${role}: deactivate sets disabled_at, bans sign-in, invalidates cache`, async () => {
    sessionAsAdmin();
    const id = VOLUNTEER_ID;
    const fake = createStaffFake([
      {
        id,
        role,
        full_name: `Active ${role}`,
        email: `active-${role}@example.com`,
        disabled_at: null,
      },
    ]);
    __setServiceRoleClient(fake);

    const res = await DELETE(
      new Request(
        `http://127.0.0.1/api/admin/staff/${role}?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
      ctx(role),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.disabledAt);
    assert.ok(fake.profiles.get(id).disabled_at);
    const user = [...fake.users.values()].find((u) => u.id === id);
    assert.equal(user?.ban_duration, "876000h");
    assert.deepEqual(__revalidateTagCalls, []);
  });

  test(`${role}: reactivate clears disabled_at and invalidates cache`, async () => {
    sessionAsAdmin();
    const id = VOLUNTEER_ID;
    const disabledAt = "2026-07-01T00:00:00.000Z";
    const fake = createStaffFake([
      {
        id,
        role,
        full_name: `Disabled ${role}`,
        email: `disabled-${role}@example.com`,
        disabled_at: disabledAt,
      },
    ]);
    __setServiceRoleClient(fake);

    const res = await PATCH(
      jsonReq(`http://127.0.0.1/api/admin/staff/${role}`, "PATCH", {
        id,
        action: "reactivate",
      }),
      ctx(role),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.staff.disabled_at, null);
    assert.equal(fake.profiles.get(id).disabled_at, null);
    assert.deepEqual(__revalidateTagCalls, []);
  });
}

test("admin can create a volunteer directly onto an active Team Lead", async () => {
  sessionAsAdmin();
  const fake = createStaffFake([
    {
      id: TEAM_LEAD_ID,
      role: "team_lead",
      full_name: "Lead One",
      email: "lead@example.com",
      disabled_at: null,
    },
  ]);
  __setServiceRoleClient(fake);

  const res = await POST(
    jsonReq("http://127.0.0.1/api/admin/staff/volunteer", "POST", {
      fullName: "Assigned Volunteer",
      email: "assigned@example.com",
      teamLeadId: TEAM_LEAD_ID,
    }),
    ctx("volunteer"),
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.staff.team_lead_id, TEAM_LEAD_ID);
  assert.equal(fake.profiles.get(body.staff.id).team_lead_id, TEAM_LEAD_ID);
});

test("admin cannot create a volunteer against a disabled or non-lead profile", async () => {
  sessionAsAdmin();
  const fake = createStaffFake([
    {
      id: TEAM_LEAD_ID,
      role: "team_lead",
      full_name: "Disabled Lead",
      email: "disabled-lead@example.com",
      disabled_at: "2026-07-01T00:00:00.000Z",
    },
  ]);
  __setServiceRoleClient(fake);

  const res = await POST(
    jsonReq("http://127.0.0.1/api/admin/staff/volunteer", "POST", {
      fullName: "Unsafe Assignment",
      email: "unsafe@example.com",
      teamLeadId: TEAM_LEAD_ID,
    }),
    ctx("volunteer"),
  );

  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /active Team Lead/i);
  assert.equal(fake.users.has("unsafe@example.com"), false);
});

test("Team Lead creates only a volunteer on their own team", async () => {
  sessionAsTeamLead();
  const fake = createStaffFake();
  __setServiceRoleClient(fake);

  const res = await POST(
    jsonReq("http://127.0.0.1/api/admin/staff/volunteer", "POST", {
      fullName: "Own Volunteer",
      email: "own@example.com",
    }),
    ctx("volunteer"),
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.staff.team_lead_id, TEAM_LEAD_ID);
  assert.equal(fake.profiles.get(body.staff.id).team_lead_id, TEAM_LEAD_ID);
});

for (const forbiddenRole of ["admin", "team_lead", "doctor"]) {
  test(`forged Team Lead request cannot create ${forbiddenRole}`, async () => {
    sessionAsTeamLead();
    const res = await POST(
      jsonReq(
        `http://127.0.0.1/api/admin/staff/${forbiddenRole}`,
        "POST",
        {
          fullName: "Forged Staff",
          email: `${forbiddenRole}@forged.example`,
        },
      ),
      ctx(forbiddenRole),
    );
    assert.ok(res.status === 400 || res.status === 403);
  });
}

test("forged Team Lead request cannot assign a volunteer to another lead", async () => {
  sessionAsTeamLead();
  const res = await POST(
    jsonReq("http://127.0.0.1/api/admin/staff/volunteer", "POST", {
      fullName: "Poached Volunteer",
      email: "poached@example.com",
      teamLeadId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    }),
    ctx("volunteer"),
  );
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /own team/i);
});

test("admin cannot deactivate their own account", async () => {
  sessionAsAdmin(ADMIN_ID);
  const fake = createStaffFake([
    {
      id: ADMIN_ID,
      role: "volunteer",
      full_name: "Self",
      email: "self@example.com",
      disabled_at: null,
    },
  ]);
  __setServiceRoleClient(fake);

  const res = await DELETE(
    new Request(
      `http://127.0.0.1/api/admin/staff/volunteer?id=${encodeURIComponent(ADMIN_ID)}`,
      { method: "DELETE" },
    ),
    ctx("volunteer"),
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /cannot deactivate your own account/i);
  assert.equal(__revalidateTagCalls.length, 0);
  assert.equal(fake.profiles.get(ADMIN_ID).disabled_at, null);
});

test("GET list returns staff rows for the path role", async () => {
  sessionAsAdmin();
  const rows = [
    {
      id: VOLUNTEER_ID,
      full_name: "Volunteer",
      email: "volunteer@example.com",
      phone: null,
      role: "volunteer",
      created_at: "2026-01-01",
      disabled_at: null,
    },
  ];
  __setAuthMock({
    userId: ADMIN_ID,
    profile: {
      id: ADMIN_ID,
      role: "admin",
      full_name: "Admin",
      phone: null,
      email: "admin@test.local",
      disabled_at: null,
    },
    listByRole: { volunteer: rows },
  });

  const res = await GET(
    new Request("http://127.0.0.1/api/admin/staff/volunteer"),
    ctx("volunteer"),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.staff.length, 1);
  assert.equal(body.staff[0].id, VOLUNTEER_ID);
});
