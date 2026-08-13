/**
 * Behavioural coverage for shared camp desk poll owner (#56).
 * Fake fetch — no React DOM, no websocket.
 */
import assert from "node:assert/strict";
import test from "node:test";

// Minimal document for visibility checks in the owner module.
if (typeof globalThis.document === "undefined") {
  globalThis.document = {
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {},
  };
}

test("out-of-order: only latest generation applies", async () => {
  const originalFetch = globalThis.fetch;
  /** @type {{url: string, signal?: AbortSignal, resolve: Function, reject: Function}[]} */
  const calls = [];

  globalThis.fetch = (url, init = {}) => {
    return new Promise((resolve, reject) => {
      calls.push({
        url: String(url),
        signal: init.signal,
        resolve,
        reject,
      });
      if (init.signal) {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }
    });
  };

  try {
    const {
      __resetCampDeskLiveForTests,
      subscribeCampDeskLive,
      refreshCampDeskLive,
      __campDeskLiveOwnerCountForTests,
    } = await import("../src/lib/camp-desk-live.ts");

    __resetCampDeskLiveForTests();
    const campId = "11111111-1111-4111-8111-111111111111";
    /** @type {import("../src/lib/camp-desk-live.ts").DeskLiveView[]} */
    const views = [];
    const unsub = subscribeCampDeskLive(campId, (v) =>
      views.push({ ...v, pendingRemovals: new Set(v.pendingRemovals) }),
    );

    assert.equal(calls.length, 1);
    refreshCampDeskLive(campId);
    await Promise.resolve();
    assert.ok(calls.length >= 2, `expected >=2 fetches, got ${calls.length}`);

    const payloadB = {
      waiting: [
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          reg_no: 2,
          full_name: "Later",
          phone: null,
        },
      ],
      waitingTotal: 1,
      days: [],
    };
    const payloadA = {
      waiting: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          reg_no: 1,
          full_name: "Stale",
          phone: null,
        },
      ],
      waitingTotal: 1,
      days: [],
    };

    const bCall = calls[calls.length - 1];
    bCall.resolve(
      new Response(JSON.stringify(payloadB), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await new Promise((r) => setTimeout(r, 30));

    const afterB = views.filter((v) => v.freshness === "fresh").at(-1);
    assert.ok(
      afterB,
      `expected fresh view after B; views=${JSON.stringify(
        views.map((v) => ({ f: v.freshness, n: v.waiting[0]?.full_name })),
      )}`,
    );
    assert.equal(afterB.waiting[0]?.full_name, "Later");

    const aCall = calls[0];
    try {
      aCall.resolve(
        new Response(JSON.stringify(payloadA), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    } catch {
      /* aborted */
    }
    await new Promise((r) => setTimeout(r, 30));

    const final = views.filter((v) => v.freshness === "fresh").at(-1);
    assert.equal(final?.waiting[0]?.full_name, "Later");

    unsub();
    assert.equal(__campDeskLiveOwnerCountForTests(), 0);
  } finally {
    globalThis.fetch = originalFetch;
    const { __resetCampDeskLiveForTests } = await import(
      "../src/lib/camp-desk-live.ts"
    );
    __resetCampDeskLiveForTests();
  }
});

test("two subscribers share one owner and one in-flight fetch", async () => {
  const originalFetch = globalThis.fetch;
  /** @type {unknown[]} */
  const calls = [];
  globalThis.fetch = (url, init = {}) => {
    calls.push(url);
    return new Promise((resolve, reject) => {
      if (init.signal) {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }
      setTimeout(() => {
        resolve(
          new Response(
            JSON.stringify({ waiting: [], waitingTotal: 0, days: [] }),
            { status: 200 },
          ),
        );
      }, 50);
    });
  };

  try {
    const {
      __resetCampDeskLiveForTests,
      subscribeCampDeskLive,
      __campDeskLiveOwnerCountForTests,
    } = await import("../src/lib/camp-desk-live.ts");
    __resetCampDeskLiveForTests();
    const campId = "22222222-2222-4222-8222-222222222222";
    const unsub1 = subscribeCampDeskLive(campId, () => {});
    const unsub2 = subscribeCampDeskLive(campId, () => {});
    assert.equal(__campDeskLiveOwnerCountForTests(), 1);
    assert.equal(calls.length, 1);
    unsub1();
    unsub2();
    assert.equal(__campDeskLiveOwnerCountForTests(), 0);
  } finally {
    globalThis.fetch = originalFetch;
    const { __resetCampDeskLiveForTests } = await import(
      "../src/lib/camp-desk-live.ts"
    );
    __resetCampDeskLiveForTests();
  }
});

test("pending removals are id-keyed and independent", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        waiting: [
          {
            id: "p1",
            reg_no: 1,
            full_name: "One",
            phone: null,
          },
          {
            id: "p2",
            reg_no: 2,
            full_name: "Two",
            phone: null,
          },
        ],
        waitingTotal: 2,
        days: [],
      }),
      { status: 200 },
    );

  try {
    const {
      __resetCampDeskLiveForTests,
      subscribeCampDeskLive,
      markDeskLivePendingRemoval,
      clearDeskLivePendingRemoval,
    } = await import("../src/lib/camp-desk-live.ts");
    __resetCampDeskLiveForTests();
    const campId = "33333333-3333-4333-8333-333333333333";
    /** @type {import("../src/lib/camp-desk-live.ts").DeskLiveView | null} */
    let view = null;
    const unsub = subscribeCampDeskLive(campId, (v) => {
      view = v;
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(view?.waiting.length, 2);

    markDeskLivePendingRemoval(campId, "p1");
    assert.equal(view?.waiting.length, 1);
    assert.equal(view?.waiting[0]?.id, "p2");

    markDeskLivePendingRemoval(campId, "p2");
    assert.equal(view?.waiting.length, 0);

    clearDeskLivePendingRemoval(campId, "p1");
    assert.equal(view?.waiting.length, 1);
    assert.equal(view?.waiting[0]?.id, "p1");

    unsub();
  } finally {
    globalThis.fetch = originalFetch;
    const { __resetCampDeskLiveForTests } = await import(
      "../src/lib/camp-desk-live.ts"
    );
    __resetCampDeskLiveForTests();
  }
});

test("failed refresh after client snapshot preserves rows and marks stale-error", async () => {
  const originalFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    if (n === 1) {
      return new Response(
        JSON.stringify({
          waiting: [
            {
              id: "p1",
              reg_no: 1,
              full_name: "Keep Me",
              phone: null,
            },
          ],
          waitingTotal: 1,
          days: [],
        }),
        { status: 200 },
      );
    }
    return new Response("nope", { status: 502 });
  };

  try {
    const {
      __resetCampDeskLiveForTests,
      subscribeCampDeskLive,
      refreshCampDeskLive,
    } = await import("../src/lib/camp-desk-live.ts");
    __resetCampDeskLiveForTests();
    const campId = "44444444-4444-4444-8444-444444444444";
    /** @type {import("../src/lib/camp-desk-live.ts").DeskLiveView | null} */
    let view = null;
    const unsub = subscribeCampDeskLive(campId, (v) => {
      view = v;
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(view?.waiting[0]?.full_name, "Keep Me");
    assert.equal(view?.freshness, "fresh");

    refreshCampDeskLive(campId);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(view?.waiting[0]?.full_name, "Keep Me");
    assert.equal(view?.freshness, "stale-error");
    unsub();
  } finally {
    globalThis.fetch = originalFetch;
    const { __resetCampDeskLiveForTests } = await import(
      "../src/lib/camp-desk-live.ts"
    );
    __resetCampDeskLiveForTests();
  }
});
