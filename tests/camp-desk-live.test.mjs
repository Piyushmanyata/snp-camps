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
      views.push({ ...v, days: [...v.days] }),
    );

    assert.equal(calls.length, 1);
    refreshCampDeskLive(campId);
    await Promise.resolve();
    assert.ok(calls.length >= 2, `expected >=2 fetches, got ${calls.length}`);

    const payloadB = { days: [{ id: "day-b", seats_left: 5 }] };
    const payloadA = { days: [{ id: "day-a", seats_left: 99 }] };

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
        views.map((v) => ({ f: v.freshness, n: v.days[0]?.id })),
      )}`,
    );
    assert.equal(afterB.days[0]?.id, "day-b");

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
    assert.equal(final?.days[0]?.id, "day-b");

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
          new Response(JSON.stringify({ days: [] }), { status: 200 }),
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

test("failed refresh after client snapshot preserves rows and marks stale-error", async () => {
  const originalFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    if (n === 1) {
      return new Response(
        JSON.stringify({ days: [{ id: "keep-me", seats_left: 3 }] }),
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
    assert.equal(view?.days[0]?.id, "keep-me");
    assert.equal(view?.freshness, "fresh");

    refreshCampDeskLive(campId);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(view?.days[0]?.id, "keep-me");
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
