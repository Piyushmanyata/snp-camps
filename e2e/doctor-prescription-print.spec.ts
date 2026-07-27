import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * The doctor who writes a prescription must be able to print it.
 *
 * Doctors deliberately hold no direct SELECT on `patients` (#56 least
 * privilege) — they read through `lookup_patient_scan`. The print page must
 * therefore not depend on a direct patient read, or the one role that authors
 * prescriptions is the one role that cannot print them.
 */

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} was not created by E2E global setup.`);
  return value;
}

async function loginDoctor(page: Page) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(env("E2E_DOCTOR_EMAIL"));
  await page.getByLabel("Password").fill(env("E2E_DOCTOR_PASSWORD"));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/doctor$/);
}

/**
 * Own fixture: the shared E2E_DOCTOR_PATIENT is consumed by the mark-seen spec,
 * and a patient can only be marked seen once.
 */
const admin = createClient(
  env("E2E_SUPABASE_URL"),
  env("E2E_SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

let patientId = "";
let patientRegNo = "";

test.beforeAll(async () => {
  const { data: camp } = await admin
    .from("camps")
    .select("id")
    .eq("is_active", true)
    .single();
  const { data: day } = await admin
    .from("camp_days")
    .select("id")
    .eq("camp_id", camp!.id)
    .order("day_date")
    .limit(1)
    .single();
  const { data: last } = await admin
    .from("patients")
    .select("reg_no")
    .order("reg_no", { ascending: false })
    .limit(1)
    .single();
  const { data, error } = await admin
    .from("patients")
    .insert({
      camp_id: camp!.id,
      camp_day_id: day!.id,
      reg_no: Number(last!.reg_no) + 1,
      full_name: `Codex E2E Patient Rx ${Date.now()}`,
      gender: "F",
      age: 47,
      queue_status: "waiting",
      queued_at: new Date().toISOString(),
    })
    .select("id, reg_no")
    .single();
  if (error) throw error;
  patientId = data.id;
  patientRegNo = String(data.reg_no);
});

test.afterAll(async () => {
  if (!patientId) return;
  await admin.from("treatment_orders").delete().eq("patient_id", patientId);
  await admin.from("prescription_amendments").delete().eq("patient_id", patientId);
  await admin.from("prescriptions").delete().eq("patient_id", patientId);
  await admin.from("patients").delete().eq("id", patientId);
});

test("a doctor can print the prescription they just wrote", async ({ page }) => {
  const clinical = {
    diagnosis: `E2E diagnosis ${Date.now()}`,
    examination: "E2E RE 6/12 LE 6/18",
    medicines: "E2E Moxifloxacin QID x7d",
    advice: "E2E follow up in 1 month",
  };

  await loginDoctor(page);

  // Reg-number path — equal to the camera path and deterministic in CI.
  await page.getByPlaceholder("e.g. 1001").fill(patientRegNo);
  await page.getByRole("button", { name: /look up patient/i }).click();

  await page.locator('input[id^="diag-"]').fill(clinical.diagnosis);
  await page.locator('input[id^="exam-"]').fill(clinical.examination);
  await page.locator('input[id^="meds-"]').fill(clinical.medicines);
  await page.locator('input[id^="adv-"]').fill(clinical.advice);
  await page
    .getByRole("button", { name: /mark seen|submit prescription|update prescription/i })
    .first()
    .click();

  await expect(page.getByText(/marked seen/i)).toBeVisible();

  await page.goto(`/print/prescription/${patientId}`);
  await page.waitForLoadState("networkidle");

  const body = page.getByTestId("prescription-clinical-body");
  await expect(body).toBeVisible();
  for (const value of Object.values(clinical)) {
    await expect(body).toContainText(value);
  }
});
