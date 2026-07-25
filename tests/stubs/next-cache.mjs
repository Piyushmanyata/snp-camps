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

export function unstable_cache(fn) {
  return fn;
}
