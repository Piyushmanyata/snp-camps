/**
 * ESM resolve hooks so App Router route handlers can be imported under node:test.
 * Stubs next/server, next/headers, server-only, and @/ path aliases.
 *
 * Usage: node --import ./tests/route-loader.mjs --test tests/foo.test.mjs
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stubs = path.join(root, "tests", "stubs");

const exact = new Map([
  ["server-only", pathToFileURL(path.join(stubs, "server-only.mjs")).href],
  ["next/server", pathToFileURL(path.join(stubs, "next-server.mjs")).href],
  ["next/headers", pathToFileURL(path.join(stubs, "next-headers.mjs")).href],
  [
    "@supabase/ssr",
    pathToFileURL(path.join(stubs, "supabase-ssr.mjs")).href,
  ],
  [
    "@/lib/supabase/admin",
    pathToFileURL(path.join(stubs, "service-role-admin.mjs")).href,
  ],
]);

function resolveAt(base, rel) {
  const candidates = [
    path.join(base, rel + ".ts"),
    path.join(base, rel + ".tsx"),
    path.join(base, rel + ".js"),
    path.join(base, rel + ".mjs"),
    path.join(base, rel, "index.ts"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return pathToFileURL(candidate).href;
    }
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (exact.has(specifier)) {
      return { shortCircuit: true, url: exact.get(specifier) };
    }

    if (specifier.startsWith("@/")) {
      const url = resolveAt(path.join(root, "src"), specifier.slice(2));
      if (url) return { shortCircuit: true, url };
    }

    // Relative imports from .ts files that omit extensions.
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const bare = path.resolve(parentDir, specifier);
      if (!path.extname(bare)) {
        const url = resolveAt(path.dirname(bare), path.basename(bare));
        if (url) return { shortCircuit: true, url };
      }
    }

    return nextResolve(specifier, context);
  },
});
