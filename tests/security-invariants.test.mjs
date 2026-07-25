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

test("health readiness is rate-limited and does not match RPC error text", () => {
  const health = read("src/app/api/health/route.ts");
  assert.match(health, /checkRateLimit/);
  assert.match(health, /scope:\s*["']health-ready["']/);
  assert.match(health, /app_database_contract/);
  assert.doesNotMatch(health, /sign in required/i);
  assert.doesNotMatch(health, /link_patient_phone/);
  // Liveness stays an early open path (ready !== "1").
  assert.match(health, /searchParams\.get\(["']ready["']\)\s*===\s*["']1["']/);
});

test("production CSP script-src has no unsafe-inline (nonce + strict-dynamic)", async () => {
  const { buildContentSecurityPolicy, productionScriptSrcAllowsUnsafeInline } =
    await import("../src/lib/csp.ts");

  const prod = buildContentSecurityPolicy("testnonce", { isDev: false });
  assert.equal(productionScriptSrcAllowsUnsafeInline(prod), false);
  assert.match(prod, /script-src 'self' 'nonce-testnonce' 'strict-dynamic'/);
  assert.doesNotMatch(prod, /script-src[^;]*'unsafe-inline'/);
  assert.doesNotMatch(prod, /script-src[^;]*'unsafe-eval'/);

  const dev = buildContentSecurityPolicy("devnonce", { isDev: true });
  assert.match(dev, /'unsafe-eval'/);
  assert.doesNotMatch(dev, /script-src[^;]*'unsafe-inline'/);

  const nextConfig = read("next.config.ts");
  assert.doesNotMatch(nextConfig, /key:\s*["']Content-Security-Policy["']/);
  assert.doesNotMatch(nextConfig, /unsafe-inline/);

  const proxy = read("src/proxy.ts");
  assert.match(proxy, /buildContentSecurityPolicy/);
  assert.match(proxy, /x-nonce/);
});

test("patient-login requires passcode and never returns or resets credentials", () => {
  const login = read("src/app/api/patient-login/route.ts");
  assert.match(login, /passcode/);
  assert.match(login, /signInWithPassword/);
  assert.match(login, /checkRateLimit/);
  assert.match(login, /scope:\s*["']patient-login["']/);
  // No shared default / credential minting on the unauthenticated login path.
  assert.doesNotMatch(login, /LEGACY_DEFAULT_PASSWORD|123456/);
  assert.doesNotMatch(login, /createUser|updateUserById|generatePatientPassword/);
  assert.doesNotMatch(login, /createServiceRoleClient/);
  // Success JSON must only acknowledge login — never include secrets.
  assert.match(
    login,
    /return NextResponse\.json\(\s*\{\s*ok:\s*true,\s*regNo,/,
  );
  assert.doesNotMatch(
    login,
    /return NextResponse\.json\(\s*\{[^}]*\b(password|email)\s*:/,
  );
  // No service-role password reset to a constant.
  assert.doesNotMatch(login, /password:\s*LEGACY|password:\s*["']123456["']/);

  const loginPage = read("src/app/patient/login/page.tsx");
  assert.match(loginPage, /label=["']Passcode["']/);
  assert.match(loginPage, /passcode:\s*code/);
  assert.doesNotMatch(loginPage, /data\.password/);

  const printSheet = read("src/components/print-sheet.tsx");
  assert.match(printSheet, /loginPasscode/);
  assert.match(printSheet, /Login passcode/);

  const context = read("CONTEXT.md");
  assert.match(context, /Desk Slip/i);
  assert.match(context, /[Pp]asscode/);

  const adr = read("docs/adr/0001-passcode-on-desk-slip.md");
  assert.match(adr, /passcode/i);
  assert.match(adr, /SMS OTP/i);
});

test("Staff vs Camp crew predicates stay aligned across TypeScript and SQL", () => {
  const roles = read("src/lib/roles.ts");
  const staffFn = roles.match(
    /export function isStaff\([^)]*\) \{[^}]+\}/,
  )?.[0];
  assert.ok(staffFn, "isStaff function body");
  assert.match(staffFn, /"admin"/);
  assert.match(staffFn, /"volunteer"/);
  assert.doesNotMatch(staffFn, /"doctor"/);

  const crewFn = roles.match(
    /export function isCampCrew\([^)]*\) \{[^}]+\}/,
  )?.[0];
  assert.ok(crewFn, "isCampCrew function body");
  assert.match(crewFn, /"doctor"/);

  const account = read("src/app/api/patient-account/route.ts");
  assert.match(account, /isStaff\(profile\?\.role\)/);
  assert.doesNotMatch(account, /isCampCrew/);

  const enter = read("src/app/patient/enter/[id]/page.tsx");
  assert.match(enter, /isCampCrew\(profile\?\.role\)/);

  const volunteer = read("src/app/volunteer/page.tsx");
  assert.match(volunteer, /isStaff\(profile\?\.role\)/);
  assert.doesNotMatch(volunteer, /isDoctor\(profile\?\.role\)\)\s*redirect/);

  const baseline = read(baselineMigrationPath());
  const sqlStaff = baseline.match(
    /CREATE FUNCTION public\.is_staff\(\)[\s\S]*?\$\$;/,
  )?.[0];
  assert.ok(sqlStaff, "SQL is_staff");
  assert.match(sqlStaff, /role in \('admin', 'volunteer'\)/);
  assert.doesNotMatch(sqlStaff, /'doctor'/);

  const sqlCrew = baseline.match(
    /CREATE FUNCTION public\.is_camp_crew\(\)[\s\S]*?\$\$;/,
  )?.[0];
  assert.ok(sqlCrew, "SQL is_camp_crew");
  assert.match(sqlCrew, /role in \('admin', 'volunteer', 'doctor'\)/);

  assert.match(baseline, /if not public\.is_camp_crew\(\)/);
});
