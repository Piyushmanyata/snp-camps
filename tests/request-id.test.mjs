import assert from "node:assert/strict";
import test from "node:test";
import { createRequestId } from "../src/lib/request-id.ts";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("createRequestId returns a UUID v4-shaped string", () => {
  const id = createRequestId();
  assert.match(id, UUID_V4);
});

test("createRequestId returns unique values across calls", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    const id = createRequestId();
    assert.equal(seen.has(id), false, `duplicate id: ${id}`);
    seen.add(id);
  }
});

test("createRequestId works when crypto.randomUUID is unavailable", () => {
  const original = globalThis.crypto;
  const getRandomValues = original?.getRandomValues?.bind(original);

  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues(bytes) {
        if (getRandomValues) return getRandomValues(bytes);
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 17 + 3) % 256;
        return bytes;
      },
    },
  });

  try {
    assert.equal(typeof globalThis.crypto.randomUUID, "undefined");
    const id = createRequestId();
    assert.match(id, UUID_V4);
  } finally {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: original,
    });
  }
});
