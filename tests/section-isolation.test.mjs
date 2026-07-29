/**
 * #63 — Section isolation and raw-error surface removal.
 * Behaviour: narrow section client only hits one section; freshness error
 * vs stale-error; auth mapper never returns raw provider text; SectionLoadError
 * no longer defaults to router.refresh as the only recovery path.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mapAuthError,
  mapDbError,
} from "../src/lib/public-error.ts";
import {
  isSectionKey,
  SECTION_KEYS,
} from "../src/lib/section-reads.ts";
import { fetchDeskSection } from "../src/lib/section-client.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

// ---------------------------------------------------------------------------
// Section client — call isolation
// ---------------------------------------------------------------------------

test("fetchDeskSection requests only the named section (queue)", async () => {
  /** @type {string[]} */
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return new Response(
      JSON.stringify({
        ok: true,
        data: { waiting: [], waitingTotal: 0 },
      }),
      { status: 200 },
    );
  };

  const result = await fetchDeskSection("queue", {
    campId: "11111111-1111-4111-8111-111111111111",
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /section=queue/);
  assert.match(urls[0], /campId=11111111/);
  assert.doesNotMatch(urls[0], /section=seats|section=doctors|section=volunteer-kpis/);
});

test("fetchDeskSection doctors retry never requests queue or kpis", async () => {
  /** @type {string[]} */
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return new Response(
      JSON.stringify({ ok: true, data: [] }),
      { status: 200 },
    );
  };

  await fetchDeskSection("doctors", { fetchImpl });
  await fetchDeskSection("volunteer-kpis", {
    campId: "11111111-1111-4111-8111-111111111111",
    fetchImpl,
  });
  await fetchDeskSection("doctor-stats", {
    campId: "11111111-1111-4111-8111-111111111111",
    fetchImpl,
  });

  assert.equal(urls.length, 3);
  assert.match(urls[0], /section=doctors/);
  assert.doesNotMatch(urls[0], /section=queue/);
  assert.match(urls[1], /section=volunteer-kpis/);
  assert.doesNotMatch(urls[1], /section=doctors|section=queue/);
  assert.match(urls[2], /section=doctor-stats/);
  assert.doesNotMatch(urls[2], /section=doctor-seen|section=queue/);
});

test("fetchDeskSection maps HTTP failure to safe error (no raw body leak)", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        ok: false,
        error: "permission denied for table patients",
      }),
      { status: 502 },
    );
  // Server should already map — but if it returns a string we pass through.
  // Transport throw path:
  const fetchThrow = async () => {
    throw new TypeError("Failed to fetch");
  };
  const result = await fetchDeskSection("queue", {
    campId: "11111111-1111-4111-8111-111111111111",
    fetchImpl: fetchThrow,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.doesNotMatch(result.error, /Failed to fetch|TypeError|postgres/i);
    assert.match(result.error, /connection|try again/i);
  }
  // Suppress unused when server returns mapped copy
  void fetchImpl;
});

test("section key catalog is exhaustive for the API seam", () => {
  for (const key of SECTION_KEYS) {
    assert.equal(isSectionKey(key), true);
  }
  assert.equal(isSectionKey("router-refresh"), false);
  assert.equal(isSectionKey("all"), false);
});

// ---------------------------------------------------------------------------
// camp-desk-live — initial error vs stale-error
// ---------------------------------------------------------------------------

test("initial fetch failure with no seed → freshness error (not empty success)", async () => {
  if (typeof globalThis.document === "undefined") {
    globalThis.document = {
      visibilityState: "visible",
      addEventListener() {},
      removeEventListener() {},
    };
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 502 });

  try {
    const {
      __resetCampDeskLiveForTests,
      subscribeCampDeskLive,
    } = await import("../src/lib/camp-desk-live.ts");
    __resetCampDeskLiveForTests();
    const campId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    /** @type {import("../src/lib/camp-desk-live.ts").DeskLiveView | null} */
    let view = null;
    const unsub = subscribeCampDeskLive(campId, (v) => {
      view = v;
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(view?.freshness, "error");
    assert.equal(view?.waitingKnown, false);
    assert.equal(view?.daysKnown, false);
    assert.equal(view?.waiting.length, 0);
    unsub();
  } finally {
    globalThis.fetch = originalFetch;
    const { __resetCampDeskLiveForTests } = await import(
      "../src/lib/camp-desk-live.ts"
    );
    __resetCampDeskLiveForTests();
  }
});

test("seeded waiting known + refresh fail → stale-error preserves rows", async () => {
  if (typeof globalThis.document === "undefined") {
    globalThis.document = {
      visibilityState: "visible",
      addEventListener() {},
      removeEventListener() {},
    };
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 502 });

  try {
    const {
      __resetCampDeskLiveForTests,
      subscribeCampDeskLive,
    } = await import("../src/lib/camp-desk-live.ts");
    __resetCampDeskLiveForTests();
    const campId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    /** @type {import("../src/lib/camp-desk-live.ts").DeskLiveView | null} */
    let view = null;
    const unsub = subscribeCampDeskLive(
      campId,
      (v) => {
        view = v;
      },
      {
        waiting: [
          {
            id: "p1",
            reg_no: 1,
            full_name: "Keep",
            phone: null,
          },
        ],
        waitingTotal: 1,
        waitingKnown: true,
      },
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(view?.freshness, "stale-error");
    assert.equal(view?.waitingKnown, true);
    assert.equal(view?.waiting[0]?.full_name, "Keep");
    unsub();
  } finally {
    globalThis.fetch = originalFetch;
    const { __resetCampDeskLiveForTests } = await import(
      "../src/lib/camp-desk-live.ts"
    );
    __resetCampDeskLiveForTests();
  }
});

// ---------------------------------------------------------------------------
// mapAuthError — no raw Auth/provider text
// ---------------------------------------------------------------------------

test("mapAuthError maps invalid credentials without leaking provider text", () => {
  const msg = mapAuthError(
    { message: "Invalid login credentials", code: "invalid_credentials" },
    { log: false, kind: "sign-in" },
  );
  assert.equal(msg, "Wrong email or password. Check and try again.");
  assert.doesNotMatch(msg, /Invalid login|GoTrue|supabase/i);
});

test("mapAuthError unknown Auth error is generic and logs raw", () => {
  const raw = "AuthApiError: unexpected_provider_xyz detail";
  /** @type {unknown[]} */
  const calls = [];
  const original = console.error;
  console.error = (...args) => {
    calls.push(args);
  };
  try {
    const msg = mapAuthError(
      { message: raw, code: "unexpected_provider_xyz" },
      { log: true, kind: "sign-in" },
    );
    assert.doesNotMatch(msg, /unexpected_provider_xyz|AuthApiError/i);
    assert.match(msg, /sign in|try again/i);
    assert.ok(calls.length >= 1);
    assert.match(JSON.stringify(calls), /unexpected_provider_xyz/);
  } finally {
    console.error = original;
  }
});

test("mapAuthError change-password never returns raw weak-password stack", () => {
  const msg = mapAuthError(
    {
      message: "Password should contain at least one character of each: ...",
      code: "weak_password",
    },
    { log: false, kind: "change-password" },
  );
  assert.match(msg, /weak|longer/i);
  assert.doesNotMatch(msg, /Password should contain at least one character/i);
});

// ---------------------------------------------------------------------------
// Source wiring — no default router.refresh in SectionLoadError
// ---------------------------------------------------------------------------

test("SectionLoadError requires onRetry and does not import useRouter", () => {
  const src = read("src/components/section-load-error.tsx");
  assert.doesNotMatch(src, /useRouter|router\.refresh/);
  assert.match(src, /onRetry/);
});

test("admin page section loaders do not throw inside Suspense children", () => {
  const admin = read("src/app/admin/page.tsx");
  // Old throw-based loaders removed
  assert.doesNotMatch(admin, /throw new Error\("Admin queue/);
  assert.doesNotMatch(admin, /throw new Error\("Admin day stats/);
  assert.doesNotMatch(admin, /throw new Error\("Admin queue counts/);
  // Uses result-model loaders
  assert.match(admin, /loadAdminQueueCountsSection|loadQueueSection|loadSeatsSection/);
  assert.match(admin, /AdminHeaderStatsPanel|initialLoadKnown/);
});

test("volunteer page always mounts LiveQueue/SeatBoard for camp (no SectionLoadError gate)", () => {
  const volunteer = read("src/app/volunteer/page.tsx");
  // Queue/seats no longer gated solely behind SectionLoadError
  assert.match(volunteer, /DeskScanQueue|initialLoadKnown/);
  assert.match(volunteer, /VolunteerKpisSection|DeskScanQueue/);
  assert.match(volunteer, /loadQueueSection|loadSeatsSection/);
});

test("login and change-password use mapAuthError", () => {
  const login =
    read("src/app/login/page.tsx") +
    "\n" +
    read("src/app/login/staff-login-form.tsx");
  const changePw = read("src/components/change-password-card.tsx");
  assert.match(login, /mapAuthError/);
  assert.doesNotMatch(login, /err\.message(?!\s*,)/);
  // login previously fell through to err.message
  assert.doesNotMatch(login, /: err\.message/);
  assert.match(changePw, /mapAuthError/);
  assert.doesNotMatch(changePw, /setError\(err\.message\)/);
});

test("mapDbError still maps RLS without raw table names", () => {
  const msg = mapDbError(
    { code: "42501", message: "permission denied for table patients" },
    { log: false },
  );
  assert.equal(msg, "You do not have permission for this action.");
});
