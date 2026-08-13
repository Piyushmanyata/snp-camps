/**
 * Stub next/cache for route-handler unit tests.
 * revalidateTag is recorded so tests can assert invalidation.
 */

/** @type {string[]} */
export const __revalidateTagCalls = [];

export function revalidateTag(tag) {
  __revalidateTagCalls.push(tag);
}

export function __resetRevalidateTagCalls() {
  __revalidateTagCalls.length = 0;
}

/** Cache Components APIs used by src/lib after #26 (no-ops under node:test). */
export function cacheTag() {}
export function cacheLife() {}
