/**
 * Minimal desk live payload + route purity (#53).
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  DESK_LIVE_WAITING_LIMIT,
  measureDeskLivePayloadBytes,
  sampleDeskLivePayload100,
} from "../src/lib/desk-live.ts";
import { GET } from "../src/app/api/desk/live/route.ts";
import {
  __resetAuthMock,
  __setAuthMock,
} from "./stubs/supabase-ssr.mjs";
import { __resetCookies } from "./stubs/next-headers.mjs";

const CREW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAMP_ID = "11111111-1111-4111-8111-111111111111";

test("100-waiting desk-live payload stays small (closing evidence)", () => {
  const payload = sampleDeskLivePayload100();
  assert.equal(payload.waiting.length, DESK_LIVE_WAITING_LIMIT);
  const bytes = measureDeskLivePayloadBytes(payload);
  // Realistic upper bound: ~15–25KB; fail hard if it balloons past 40KB.
  assert.ok(bytes < 40_000, `payload ${bytes} bytes too large`);
  console.log("DESK_LIVE_PAYLOAD_100_BYTES", bytes);
});

test("desk-live route source never loads doctors or staff KPIs", () => {
  const root = process.cwd();
  const src = fs.readFileSync(
    path.join(root, "src/app/api/desk/live/route.ts"),
    "utf8",
  );
  assert.doesNotMatch(src, /getDoctorsList/);
  assert.doesNotMatch(src, /staff_person_kpis/);
  assert.doesNotMatch(src, /doctors-list/);
  assert.match(src, /camp_day_stats/);
  assert.match(src, /queue_status.*waiting|waiting/);
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
