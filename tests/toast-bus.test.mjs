import assert from "node:assert/strict";
import test from "node:test";
import {
  setToastListener,
  showErrorToast,
  showSuccessToast,
} from "../src/lib/toast-bus.ts";

test("showErrorToast and showSuccessToast deliver tone + message to the listener", () => {
  /** @type {{ tone: string, message: string }[]} */
  const seen = [];
  setToastListener((toast) => {
    seen.push(toast);
  });

  showErrorToast("boom");
  showSuccessToast("ok");

  assert.deepEqual(seen, [
    { tone: "error", message: "boom" },
    { tone: "success", message: "ok" },
  ]);

  setToastListener(null);
});

test("setToastListener(null) unsets the listener so later calls are no-ops", () => {
  let calls = 0;
  setToastListener(() => {
    calls += 1;
  });
  showSuccessToast("once");
  setToastListener(null);
  showErrorToast("ignored");
  showSuccessToast("ignored too");
  assert.equal(calls, 1);
});

test("replacing the listener stops delivering to the previous one", () => {
  /** @type {string[]} */
  const a = [];
  /** @type {string[]} */
  const b = [];
  setToastListener((t) => a.push(t.message));
  showSuccessToast("for-a");
  setToastListener((t) => b.push(t.message));
  showErrorToast("for-b");
  assert.deepEqual(a, ["for-a"]);
  assert.deepEqual(b, ["for-b"]);
  setToastListener(null);
});
