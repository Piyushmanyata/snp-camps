import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const readSource = (relativePath) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

const loginSource = readSource("src/app/patient/login/page.tsx");
const registrationSource = readSource("src/components/patient-form.tsx");
const accountSource = readSource("src/app/api/patient-account/route.ts");
const registerRouteSource = readSource("src/app/api/patient-register/route.ts");

test("patient OTP supports desk claims and sends first-time users to registration", () => {
  assert.match(
    loginSource,
    /signInWithOtp\(\{\s*phone: phoneE164,\s*options: \{ shouldCreateUser: true \},\s*\}\)/,
  );
  assert.match(
    registrationSource,
    /signInWithOtp\(\{\s*phone: phoneE164,\s*options: \{ shouldCreateUser: true \},\s*\}\)/,
  );
  assert.match(loginSource, /if \(!linkedId\) \{\s*router\.replace\("\/register"\)/);
  assert.match(
    registrationSource,
    /hasVerifiedPatientSession[\s\S]*?isStaff \|\| hasVerifiedPatientSession \? "form" : "phone"/,
  );
});

test("self-registration is bound to the confirmed phone in the auth session", () => {
  assert.match(
    registerRouteSource,
    /const hasVerifiedPhone =[\s\S]*Boolean\(user\.phone_confirmed_at\)[\s\S]*sessionPhone\.length === 10/,
  );
  assert.match(
    registerRouteSource,
    /from\("patients"\)[\s\S]*?eq\("user_id", user\.id\)[\s\S]*?const isProvisionedPatient =[\s\S]*?Boolean\(linkedIdentity\)/,
  );
  assert.doesNotMatch(registerRouteSource, /isProvisionedPatient[\s\S]{0,160}?patients\\\.snp\\\.local/);
  assert.match(registerRouteSource, /const identityPhone = hasVerifiedPhone[\s\S]*sessionProfile\?\.phone/);
  assert.match(registerRouteSource, /if \(phone && phone !== identityPhone\)/);
});

test("OTP login performs a bounded linked-patient lookup and fails closed", () => {
  const verifyStart = loginSource.indexOf("async function verifyOtp");
  const verifyEnd = loginSource.indexOf("\n  return (", verifyStart);
  const verifySource = loginSource.slice(verifyStart, verifyEnd);
  const queryErrorCheck = verifySource.indexOf("if (linkedError)");
  const phoneLinkAttempt = verifySource.indexOf('"link_patient_phone"');

  assert.match(
    verifySource,
    /\.eq\("user_id", user\.id\)\s*\.limit\(1\)\s*\.maybeSingle\(\)/,
  );
  assert.ok(queryErrorCheck > -1 && queryErrorCheck < phoneLinkAttempt);
  assert.match(
    verifySource.slice(queryErrorCheck, phoneLinkAttempt),
    /await supabase\.auth\.signOut\(\);[\s\S]*setError\([\s\S]*return;/,
  );
});

test("backup credentials use the account API login reg number", () => {
  assert.match(accountSource, /regNo: regNoToReturn,/);
  assert.match(accountSource, /queueNotification\(regNoToReturn\)/);
  assert.match(
    registrationSource,
    /loginRegNo:\s*typeof acc\.regNo === "number" \? acc\.regNo : base\.reg_no/,
  );
  assert.match(
    registrationSource,
    /Registered & signed in[\s\S]*#\{created\.reg_no\}/,
  );
});
