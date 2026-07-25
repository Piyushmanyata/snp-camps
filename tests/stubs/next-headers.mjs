/** Test stub for next/headers cookies(). */
const store = new Map();

export function __resetCookies(entries = []) {
  store.clear();
  for (const { name, value } of entries) {
    store.set(name, value);
  }
}

export async function cookies() {
  return {
    getAll() {
      return [...store.entries()].map(([name, value]) => ({ name, value }));
    },
    get(name) {
      if (!store.has(name)) return undefined;
      return { name, value: store.get(name) };
    },
    set(name, value) {
      store.set(name, value);
    },
  };
}
