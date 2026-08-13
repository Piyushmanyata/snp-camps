/**
 * Minimal desk live payload + route purity (#53).
 * The poll carries the seat board only — there is no queue (ADR 0013).
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { GET } from "../src/app/api/desk/live/route.ts";
import {
  __resetAuthMock,
  __setAuthMock,
} from "./stubs/supabase-ssr.mjs";
import { __resetCookies } from "./stubs/next-headers.mjs";

const CREW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAMP_ID = "11111111-1111-4111-8111-111111111111";

test("desk-live route reads the seat board and nothing else", () => {
  const root = process.cwd();
  const src = fs.readFileSync(
    path.join(root, "src/app/api/desk/live/route.ts"),
    "utf8",
  );
  assert.doesNotMatch(src, /getDoctorsList/);
  assert.doesNotMatch(src, /staff_person_kpis/);
  assert.doesNotMatch(src, /doctors-list/);
  assert.doesNotMatch(src, /desk_waiting_queue/);
  assert.match(src, /camp_day_stats/);
});

test("GET /api/desk/live rejects unauthenticated and non-crew", async () => {
  __resetAuthMock();
  __resetCookies([]);
  const bare = await GET(
    new Request(`http://local/api/desk/live?campId=${CAMP_ID}`),
  );
  assert.equal(bare.status, 401);

  __resetCookies([{ name: "sb-test-auth-token", value: "1" }]);
  __setAuthMock({
    userId: CREW_ID,
    profile: {
      id: CREW_ID,
      role: "patient",
      full_name: "P",
      phone: null,
      email: null,
      disabled_at: null,
    },
  });
  const denied = await GET(
    new Request(`http://local/api/desk/live?campId=${CAMP_ID}`),
  );
  assert.equal(denied.status, 403);
});

test("GET /api/desk/live requires campId UUID", async () => {
  __resetCookies([{ name: "sb-test-auth-token", value: "1" }]);
  __setAuthMock({
    userId: CREW_ID,
    profile: {
      id: CREW_ID,
      role: "volunteer",
      full_name: "V",
      phone: null,
      email: null,
      disabled_at: null,
    },
  });
  const missing = await GET(new Request("http://local/api/desk/live"));
  assert.equal(missing.status, 400);
  const bad = await GET(
    new Request("http://local/api/desk/live?campId=not-a-uuid"),
  );
  assert.equal(bad.status, 400);
});
