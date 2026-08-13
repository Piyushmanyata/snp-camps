/**
 * Deliberate source-text security invariants — the only suite allowed to
 * assert on source/schema text.
 *
 * Boundary rule (all three required; otherwise the assertion is behaviour
 * and belongs in a behavioural test, not here):
 *
 * 1. About a file's existence, its imports, or the absence of a token —
 *    never about the shape of an expression.
 * 2. No behavioural way to express it. "This secret never reaches the
 *    client bundle" qualifies. "This endpoint does not return a password"
 *    does not — that is a response body.
 * 3. The regex matches an identifier or an import path — never punctuation,
 *    whitespace, or argument layout.
 *
 * Keep: service-role absent from client code; admin module imports
 * server-only; every public CREATE TABLE has ENABLE RLS; at most one SQL
 * role-set assertion for is_staff / is_camp_crew (SQL function bodies have
 * no other seam).
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
  // pg_dump may quote identifiers: public.patients or "public"."patients"
  const tables = [
    ...schema.matchAll(
      /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(?:"?public"?\.)"?([a-z_]+)"?/gi,
    ),
  ].map((m) => m[1].toLowerCase());

  assert.ok(
    tables.length > 0,
    `expected public tables in ${relative}`,
  );

  for (const table of tables) {
    const enabled = new RegExp(
      `ALTER TABLE\\s+(?:"?public"?\\.)?"?${table}"?\\s+ENABLE ROW LEVEL SECURITY`,
      "i",
    );
    assert.match(
      schema,
      enabled,
      `public.${table} must ENABLE ROW LEVEL SECURITY`,
    );
  }
});

/**
 * SQL role-set seam: is_staff / is_camp_crew bodies are not callable from
 * node:test. Assert only the role-name string literals inside each function
 * definition (not TypeScript, not call-site greps).
 */
test("SQL keeps Registration Staff separate from Clinical Desk crew", () => {
  const migrationsDir = path.join(root, "supabase", "migrations");
  const sqlAll = fs
    .readdirSync(migrationsDir)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort()
    .map((name) => read(path.join("supabase", "migrations", name)))
    .join("\n");

  // Last definition wins in Postgres; scan every CREATE of each function.
  const staffDefs = [
    ...sqlAll.matchAll(
      /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+(?:"?public"?\.)?"?is_staff"?\s*\(\s*\)[\s\S]*?\$\$;/gi,
    ),
  ].map((m) => m[0]);
  assert.ok(staffDefs.length > 0, "expected at least one is_staff() definition");
  const sqlStaff = staffDefs[staffDefs.length - 1];
  assert.match(sqlStaff, /'admin'/);
  assert.match(sqlStaff, /'volunteer'/);
  assert.doesNotMatch(sqlStaff, /'doctor'/);
  assert.doesNotMatch(sqlStaff, /'clinical_operator'/);

  const crewDefs = [
    ...sqlAll.matchAll(
      /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+(?:"?public"?\.)?"?is_camp_crew"?\s*\(\s*\)[\s\S]*?\$\$;/gi,
    ),
  ].map((m) => m[0]);
  assert.ok(crewDefs.length > 0, "expected at least one is_camp_crew() definition");
  const sqlCrew = crewDefs[crewDefs.length - 1];
  const crewBody = sqlCrew.split(/drop function/i, 1)[0];
  assert.match(crewBody, /is_staff/);
  assert.doesNotMatch(crewBody, /is_clinical_operator/);

  const clinicalDefs = [
    ...sqlAll.matchAll(
      /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+(?:"?public"?\.)?"?is_clinical_operator"?\s*\(\s*\)[\s\S]*?\$\$;/gi,
    ),
  ].map((m) => m[0]);
  assert.ok(clinicalDefs.length > 0);
  assert.match(clinicalDefs.at(-1), /'clinical_operator'/);
});
