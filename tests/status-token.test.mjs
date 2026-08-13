import assert from "node:assert/strict";
import test from "node:test";
import {
  generateStatusToken,
  isStatusTokenFormat,
  STATUS_TOKEN_HEX_LENGTH,
} from "../src/lib/status-token.ts";

test("generateStatusToken is 128-bit hex and unique across samples", () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const t = generateStatusToken();
    assert.equal(t.length, STATUS_TOKEN_HEX_LENGTH);
    assert.equal(isStatusTokenFormat(t), true);
    assert.equal(seen.has(t), false, "token collision");
    seen.add(t);
  }
});

test("isStatusTokenFormat rejects UUID, reg numbers, and short tokens", () => {
  assert.equal(isStatusTokenFormat("e3b0c44298fc41c4a0123456789abcde"), true);
  assert.equal(
    isStatusTokenFormat("e3b0c442-98fc-41c4-a012-3456789abcde"),
    false,
  );
  assert.equal(isStatusTokenFormat("12345"), false);
  assert.equal(isStatusTokenFormat(""), false);
  assert.equal(isStatusTokenFormat("G".repeat(32).toLowerCase()), false);
});
