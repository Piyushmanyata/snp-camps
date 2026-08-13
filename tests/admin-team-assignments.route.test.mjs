import assert from "node:assert/strict";
import test from "node:test";
import { PATCH } from "../src/app/api/admin/team-assignments/route.ts";
import { __resetCookies } from "./stubs/next-headers.mjs";
import {
  __resetAuthMock,
  __setAuthMock,
} from "./stubs/supabase-ssr.mjs";
import {
  __resetServiceRoleClient,
  __setServiceRoleClient,
} from "./stubs/service-role-admin.mjs";

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VOLUNTEER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEAD_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function signIn(role = "admin") {
  __resetCookies([{ name: "sb-test-auth-token", value: "session" }]);
  __setAuthMock({
    userId: ADMIN_ID,
    profile: {
      id: ADMIN_ID,
      role,
      full_name: "Manager",
      disabled_at: null,
    },
  });
}

function request(body) {
  return new Request("http://localhost/api/admin/team-assignments", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function assignmentFake({ found = true, error = null } = {}) {
  const state = { payload: null, filters: [] };
  const chain = {
    update(payload) {
      state.payload = payload;
      return chain;
    },
    eq(column, value) {
      state.filters.push([column, value]);
      return chain;
    },
    select() {
      return chain;
    },
    maybeSingle() {
      return Promise.resolve({
        data: found
          ? { id: VOLUNTEER_ID, team_lead_id: state.payload.team_lead_id }
          : null,
        error,
      });
    },
  };
  return {
    state,
    client: {
      from(table) {
        assert.equal(table, "profiles");
        return chain;
      },
    },
  };
}

test.beforeEach(() => {
  __resetCookies();
  __resetAuthMock();
  __resetServiceRoleClient();
});

test("admin can assign, move, and unassign only a volunteer row", async () => {
  signIn();
  const fake = assignmentFake();
  __setServiceRoleClient(fake.client);

  let response = await PATCH(
    request({ volunteerId: VOLUNTEER_ID, teamLeadId: LEAD_ID }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(fake.state.payload, { team_lead_id: LEAD_ID });
  assert.deepEqual(fake.state.filters, [
    ["id", VOLUNTEER_ID],
    ["role", "volunteer"],
  ]);

  const unassign = assignmentFake();
  __setServiceRoleClient(unassign.client);
  response = await PATCH(
    request({ volunteerId: VOLUNTEER_ID, teamLeadId: null }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(unassign.state.payload, { team_lead_id: null });
});

test("unauthenticated and non-admin callers are rejected before mutation", async () => {
  let response = await PATCH(
    request({ volunteerId: VOLUNTEER_ID, teamLeadId: LEAD_ID }),
  );
  assert.equal(response.status, 401);

  signIn("team_lead");
  response = await PATCH(
    request({ volunteerId: VOLUNTEER_ID, teamLeadId: LEAD_ID }),
  );
  assert.equal(response.status, 403);
});

test("invalid ids and non-volunteer targets fail closed", async () => {
  signIn();
  let response = await PATCH(
    request({ volunteerId: "not-a-uuid", teamLeadId: LEAD_ID }),
  );
  assert.equal(response.status, 400);

  const fake = assignmentFake({ found: false });
  __setServiceRoleClient(fake.client);
  response = await PATCH(
    request({ volunteerId: VOLUNTEER_ID, teamLeadId: LEAD_ID }),
  );
  assert.equal(response.status, 404);
});
