/**
 * Deliberate source-text security invariants.
 *
 * These are the only tests allowed to assert on source/schema text: they guard
 * properties that pure unit tests of pure functions cannot express.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walkFiles(full, out);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test("service-role key never appears in client components or browser client", () => {
  const browserClient = read("src/lib/supabase/client.ts");
  assert.match(browserClient, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  assert.doesNotMatch(browserClient, /SERVICE_ROLE|service_role/i);

  const componentsDir = path.join(root, "src/components");
  for (const file of walkFiles(componentsDir)) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /SUPABASE_SERVICE_ROLE_KEY|createServiceRoleClient/,
      `${path.relative(root, file)} must not touch the service-role client`,
    );
  }

  // App Router client pages under app/ that are "use client" must not import admin.
  const appDir = path.join(root, "src/app");
  for (const file of walkFiles(appDir)) {
    const source = fs.readFileSync(file, "utf8");
    if (!/^\s*["']use client["']/.test(source)) continue;
    assert.doesNotMatch(
      source,
      /SUPABASE_SERVICE_ROLE_KEY|createServiceRoleClient|@\/lib\/supabase\/admin/,
      `${path.relative(root, file)} is a client module and must not use service role`,
    );
  }
});

test("service-role admin client is server-only", () => {
  const admin = read("src/lib/supabase/admin.ts");
  assert.match(admin, /import ["']server-only["']/);
  assert.match(admin, /SUPABASE_SERVICE_ROLE_KEY/);
});

function baselineMigrationPath() {
  const dir = path.join(root, "supabase", "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(files.length > 0, "expected at least one migration under supabase/migrations");
  // RLS is declared in the baseline (full schema). Later migrations may only alter it.
  const baseline =
    files.find((name) => name.includes("baseline")) ?? files[0];
  return path.join("supabase", "migrations", baseline);
}

test("every public table in the baseline migration has RLS enabled", () => {
  const relative = baselineMigrationPath();
  const schema = read(relative);
  const tables = [
    ...schema.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+public\.([a-z_]+)/gi),
  ].map((m) => m[1].toLowerCase());

  assert.ok(
    tables.length > 0,
    `expected public tables in ${relative}`,
  );

  for (const table of tables) {
    const enabled = new RegExp(
      `ALTER TABLE public\\.${table}\\s+ENABLE ROW LEVEL SECURITY`,
      "i",
    );
    assert.match(
      schema,
      enabled,
      `public.${table} must ENABLE ROW LEVEL SECURITY`,
    );
  }
});
