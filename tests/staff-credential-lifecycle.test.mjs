import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `Missing ${start}`);
  assert.notEqual(to, -1, `Missing ${end}`);
  return source.slice(from, to);
}

const staff = [
  {
    role: "doctor",
    route: read("src/app/api/admin/doctors/route.ts"),
    component: read("src/components/admin-doctors.tsx"),
    page: read("src/app/doctor/page.tsx"),
  },
  {
    role: "volunteer",
    route: read("src/app/api/admin/volunteers/route.ts"),
    component: read("src/components/admin-volunteers.tsx"),
    page: read("src/app/volunteer/page.tsx"),
  },
];

for (const { role, route, component, page } of staff) {
  test(`${role} creation uses a server-generated, one-time temporary password`, () => {
    const post = between(route, "export async function POST", "export async function PATCH");

    assert.match(route, /import \{ randomInt \} from "node:crypto"/);
    assert.match(route, /function generateTemporaryPassword\(length = 14\)/);
    assert.match(post, /const password = generateTemporaryPassword\(\)/);
    assert.doesNotMatch(post, /body\.password/);
    assert.match(post, /auth\.admin\.createUser\(\{[\s\S]*?password,/);
    assert.match(post, /temporaryPassword: password/);
    assert.match(post, /"Cache-Control": "no-store"/);
    assert.match(post, /That email is already registered/);

    assert.doesNotMatch(component, /type="password"/);
    assert.match(component, /body: JSON\.stringify\(\{ fullName, email \}\)/);
    assert.match(component, /temporaryPassword\?: string/);
    assert.match(component, /navigator\.clipboard\.writeText/);
    assert.match(component, /shown once/);
  });

  test(`${role} reset is admin-only, active-only, no-store, and double-submit guarded`, () => {
    const patch = between(route, "export async function PATCH", "export async function DELETE");

    assert.match(patch, /await requireAdmin\(\)/);
    assert.match(patch, /createServiceRoleClient\(\)/);
    assert.match(patch, new RegExp(`profile\\.role !== "${role}"`));
    assert.match(patch, /if \(profile\.disabled_at\)/);
    assert.match(patch, /auth\.admin\.updateUserById\(id, \{[\s\S]*?password: temporaryPassword/);
    assert.match(patch, /"Cache-Control": "no-store"/);

    assert.match(component, /method: "PATCH"/);
    assert.match(component, /if \(busy\) return/);
    assert.match(component, /disabled=\{busy\}/);
    assert.match(component, /aria-busy=/);
    assert.match(component, /current password will stop working immediately/);
  });

  test(`${role} disabled accounts stay listed and can be safely reactivated`, () => {
    const get = between(route, "export async function GET", "export async function POST");
    const patch = between(route, "export async function PATCH", "export async function DELETE");

    assert.match(get, /created_at, disabled_at/);
    assert.doesNotMatch(get, /\.is\("disabled_at", null\)/);
    assert.match(patch, /action\?: "reset_password" \| "reactivate"/);
    assert.match(patch, /ban_duration: "none"/);
    assert.match(patch, /if \(!disabledAt\)[\s\S]*?disabled_at: null/);
    assert.match(patch, /\.eq\("disabled_at", disabledAt\)/);
    assert.match(patch, /ban_duration: "876000h"/);
    assert.match(component, /action: "reactivate"/);
    assert.match(component, /Reactivate/);
    assert.match(component, /disabled_at: null/);
    assert.match(page, /created_at, disabled_at/);
    assert.doesNotMatch(page, /\.is\("disabled_at", null\)/);
  });

  test(`${role} one-time credentials block mutations until confirmed dismissal`, () => {
    assert.match(component, /credential !== null/);
    assert.match(component, /credentialHeadingRef\.current\?\.focus\(\)/);
    assert.match(component, /Have you securely saved or shared this temporary password\?/);
    assert.match(component, /tabIndex=\{-1\}/);

    const reset = between(component, `async function onReset`, `async function onReactivate`);
    assert.doesNotMatch(reset, /setCredential\(null\)/);
  });

  test(`${role} controls and asynchronous feedback are accessible`, () => {
    assert.match(component, /aria-expanded=\{open\}/);
    assert.match(component, new RegExp(`aria-controls=\\{\`${role}-detail-\\$\\{`));
    assert.match(component, /aria-expanded=\{showForm\}/);
    assert.match(component, /aria-controls=/);
    assert.match(component, /role="status"/);
    assert.match(component, /aria-live="polite"/);
    assert.match(component, /<SuccessBox message=\{ok\} \/>/);
  });
}

test("admin can change their own password", () => {
  const component = read("src/components/sign-out.tsx");
  assert.match(component, /Change password/);
  assert.match(component, /handleChangePassword/);
});

test("patient one-time credentials block mutations and require confirmed dismissal", () => {
  const component = read("src/components/admin-patients.tsx");
  assert.match(component, /accountBusyId !== null \|\| credential !== null/);
  assert.match(component, /credentialHeadingRef\.current\?\.focus\(\)/);
  assert.match(component, /Have you securely saved or shared this temporary password\?/);
  assert.match(component, /aria-labelledby="patient-credential-heading"/);
});
