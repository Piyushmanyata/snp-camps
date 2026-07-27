import { expect, test, type Page } from "@playwright/test";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} was not created by E2E global setup.`);
  return value;
}

async function gotoHydrated(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

async function loginStaff(page: Page, role: "admin" | "volunteer" | "doctor") {
  await gotoHydrated(page, "/login");
  await page.getByLabel("Email").fill(env(`E2E_${role.toUpperCase()}_EMAIL`));
  await page
    .getByLabel("Password")
    .fill(env(`E2E_${role.toUpperCase()}_PASSWORD`));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`/${role}$`));
}

async function blockRemoteRequests(page: Page) {
  const allowedHosts = new Set([
    ...loopbackHosts,
    ...(process.env.E2E_SUPABASE_URL
      ? [new URL(process.env.E2E_SUPABASE_URL).hostname]
      : []),
    ...(process.env.NEXT_PUBLIC_SUPABASE_URL
      ? [new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname]
      : []),
  ]);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !allowedHosts.has(url.hostname)
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

test.beforeEach(async ({ page, context }) => {
  await context.clearCookies();
  await blockRemoteRequests(page);
});

test("public entry points and protected-route redirects", async ({
  page,
  request,
}) => {
  const health = await request.get("/api/health");
  expect(health.ok()).toBeTruthy();

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Medical Camp Desk" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /Patient login/ })).toHaveCount(
    0,
  );
  await expect(page.getByRole("link", { name: /Staff login/ })).toBeVisible();

  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/volunteer");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/doctor");
  await expect(page).toHaveURL(/\/login$/);

  // Retired patient portal routes should not serve an app shell.
  await page.goto("/patient");
  await expect(page.getByRole("heading", { name: "My profile" })).toHaveCount(
    0,
  );
  await page.goto("/patient/login");
  await expect(
    page.getByRole("heading", { name: /Patient login/i }),
  ).toHaveCount(0);
});

test("credential forms never put secrets in the URL before hydration", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await blockRemoteRequests(page);
  const marker = "e2e-no-js-password";

  await page.goto(`${env("E2E_BASE_URL")}/login`);
  await page.getByLabel("Email").first().fill("no-js@snp.local");
  await page.getByLabel("Password").first().fill(marker);
  await page.getByRole("button", { name: "Sign in" }).first().click();
  expect(page.url()).not.toContain(marker);
  expect(new URL(page.url()).search).toBe("");

  await context.close();
});

test("admin can sign in, inspect the patient desk, and sign out", async ({
  page,
}) => {
  await loginStaff(page, "admin");
  await expect(page.getByRole("heading", { name: "Admin", exact: true })).toBeVisible();
  await expect(
    page.getByText("Camps & camp days", { exact: true }),
  ).toBeVisible();

  await page.goto("/admin/patients");
  await expect(
    page.getByRole("heading", { name: "Patient desk" }),
  ).toBeVisible();
  await page.getByLabel("Filter list").fill(env("E2E_PATIENT_REG_NO"));
  await expect(
    page.getByText(`#${env("E2E_PATIENT_REG_NO")}`, { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("volunteer can sign in and safely review a patient", async ({ page }) => {
  await loginStaff(page, "volunteer");
  await expect(
    page.getByRole("heading", { name: "Volunteer desk" }),
  ).toBeVisible();

  await page.getByLabel("Reg no").fill(env("E2E_PATIENT_REG_NO"));
  await page.getByRole("button", { name: "Look up patient" }).click();
  const review = page.getByRole("region", {
    name: `#${env("E2E_PATIENT_REG_NO")} · ${env("E2E_PATIENT_NAME")}`,
  });
  await expect(review).toBeVisible();
  await expect(
    review.getByRole("button", { name: "Assign doctor · mark seen" }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("volunteer doctor picker is populated (not silently empty)", async ({
  page,
}) => {
  await loginStaff(page, "volunteer");
  await expect(
    page.getByRole("heading", { name: "Volunteer desk" }),
  ).toBeVisible();

  // Error path must not appear when service-role is configured.
  await expect(
    page.getByText("Doctor list unavailable. Tell an admin."),
  ).toHaveCount(0);
  await expect(page.getByText("No doctors added yet.")).toHaveCount(0);

  await page.getByLabel("Reg no").fill(env("E2E_PATIENT_REG_NO"));
  await page.getByRole("button", { name: "Look up patient" }).click();
  const review = page.getByRole("region", {
    name: `#${env("E2E_PATIENT_REG_NO")} · ${env("E2E_PATIENT_NAME")}`,
  });
  await expect(review).toBeVisible();

  const doctorPicker = review.getByRole("group", { name: "Select doctor" });
  await expect(doctorPicker).toBeVisible();
  await expect(
    doctorPicker.getByRole("button", { name: /Codex E2E doctor/i }),
  ).toBeVisible();
});

/**
 * #26 — revalidateTag("doctors-list") after staff mutation must refresh the
 * volunteer picker without a hard browser reload (soft navigation is enough).
 *
 * Order matters: warm the volunteer desk first so the cross-request cache holds
 * a list without the new doctor, then mutate, then soft-navigate again.
 */
test("admin doctor create invalidates volunteer picker without hard reload", async ({
  browser,
}) => {
  const stamp = Date.now();
  const doctorName = `E2E Cache Doc ${stamp}`;
  const doctorEmail = `e2e-cache-doc-${stamp}@example.com`;

  const volunteerContext = await browser.newContext();
  const volunteerPage = await volunteerContext.newPage();
  await blockRemoteRequests(volunteerPage);
  await loginStaff(volunteerPage, "volunteer");
  await volunteerPage.goto("/volunteer");
  await volunteerPage.waitForLoadState("networkidle");
  await volunteerPage
    .getByLabel("Reg no")
    .fill(env("E2E_PATIENT_REG_NO"));
  await volunteerPage.getByRole("button", { name: "Look up patient" }).click();
  const reviewBefore = volunteerPage.getByRole("region", {
    name: `#${env("E2E_PATIENT_REG_NO")} · ${env("E2E_PATIENT_NAME")}`,
  });
  await expect(reviewBefore).toBeVisible();
  const pickerBefore = reviewBefore.getByRole("group", {
    name: "Select doctor",
  });
  await expect(
    pickerBefore.getByRole("button", { name: /Codex E2E doctor/i }),
  ).toBeVisible();
  await expect(
    pickerBefore.getByRole("button", { name: doctorName }),
  ).toHaveCount(0);

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await blockRemoteRequests(adminPage);
  await loginStaff(adminPage, "admin");

  // Admin manages doctors on /doctor (not the main admin dashboard).
  await adminPage.goto("/doctor");
  await expect(
    adminPage.getByRole("heading", { name: "Doctor desk" }),
  ).toBeVisible();
  await adminPage.getByRole("button", { name: "Add doctor" }).click();
  await adminPage.getByLabel("Full name").fill(doctorName);
  await adminPage.getByLabel("Email").fill(doctorEmail);
  await adminPage
    .getByRole("button", { name: "Create doctor & get password" })
    .click();
  await expect(
    adminPage.getByText("Doctor created. Share the temporary password below", {
      exact: false,
    }),
  ).toBeVisible();

  // Soft navigation only — proves tag invalidation, not a full browser hard reload.
  await volunteerPage.goto("/volunteer");
  await volunteerPage.waitForLoadState("networkidle");
  await volunteerPage
    .getByLabel("Reg no")
    .fill(env("E2E_PATIENT_REG_NO"));
  await volunteerPage.getByRole("button", { name: "Look up patient" }).click();
  const reviewAfter = volunteerPage.getByRole("region", {
    name: `#${env("E2E_PATIENT_REG_NO")} · ${env("E2E_PATIENT_NAME")}`,
  });
  await expect(reviewAfter).toBeVisible();
  const pickerAfter = reviewAfter.getByRole("group", { name: "Select doctor" });
  await expect(
    pickerAfter.getByRole("button", { name: doctorName }),
  ).toBeVisible();

  await adminContext.close();
  await volunteerContext.close();
});

test("doctor can sign in and review without mutating patient status", async ({
  page,
}) => {
  await loginStaff(page, "doctor");
  await expect(page.getByRole("heading", { name: "Doctor" })).toBeVisible();

  await page.getByLabel("Reg no").fill(env("E2E_PATIENT_REG_NO"));
  await page.getByRole("button", { name: "Look up patient" }).click();
  const review = page.getByRole("region", {
    name: `#${env("E2E_PATIENT_REG_NO")} · ${env("E2E_PATIENT_NAME")}`,
  });
  await expect(review).toBeVisible();
  // #50 — one full-width Mark seen; no confirmation dialog label
  await expect(review.getByRole("button", { name: "Mark seen" })).toBeVisible();
  await expect(
    review.getByRole("button", { name: /Confirm patient/i }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
});

/** #105 — counter desk and prescription print page are reachable without typing a URL. */
test("admin volunteer and doctor can reach counter from navigation", async ({
  page,
}) => {
  for (const role of ["admin", "volunteer", "doctor"] as const) {
    await loginStaff(page, role);
    // Prefer the in-page link (desktop); fall back to the mobile dock label.
    const counterLink = page.getByRole("link", { name: /Counter/ }).first();
    await expect(counterLink).toBeVisible();
    await counterLink.click();
    await expect(page).toHaveURL(/\/counter$/);
    await expect(
      page.getByRole("heading", { name: "Counter desk" }),
    ).toBeVisible();
    // Prescription print route stays camp-crew gated; open by path after counter is live.
    await page.goto(`/print/prescription/${env("E2E_PATIENT_ID")}`);
    await expect(page).not.toHaveURL(/\/login$/);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/$/);
  }
});

test("staff-scan QR never logs a public visitor in", async ({ page }) => {
  const patientId = env("E2E_PATIENT_ID");

  await page.goto(`/p/${patientId}`);
  await expect(
    page.getByRole("heading", { name: /Camp desk scan only|Invalid code/i }),
  ).toBeVisible();
  await expect(page.getByText(/does not log you in|for camp staff/i)).toBeVisible();
});

test("invalid QR path shows clear help", async ({ page }) => {
  await page.goto("/p/not-a-uuid");
  await expect(page.getByRole("heading", { name: "Invalid code" })).toBeVisible();
  await expect(page.getByText(/Show this screen at the camp desk/i)).toBeVisible();
});

test("staff deep-link scan opens lookup-first desk", async ({ page }) => {
  const patientId = env("E2E_PATIENT_ID");
  await loginStaff(page, "volunteer");

  await page.goto(`/p/${patientId}`);
  await expect(page).toHaveURL(
    new RegExp(
      `^https?://(127\\.0\\.0\\.1|localhost)(:\\d+)?/volunteer\\?scan=${patientId}$`,
    ),
  );

  const review = page.getByRole("region", {
    name: `#${env("E2E_PATIENT_REG_NO")} · ${env("E2E_PATIENT_NAME")}`,
  });
  await expect(review).toBeVisible({ timeout: 15_000 });
  // Lookup only — no doctor chosen yet, so assign stays disabled
  await expect(
    review.getByRole("button", { name: "Assign doctor · mark seen" }),
  ).toBeDisabled();
});

test("garbage reg/QR text fails closed without crashing desk", async ({
  page,
}) => {
  await loginStaff(page, "doctor");
  await page
    .getByLabel("Reg no")
    .fill("not-a-patient!!!!!" + "x".repeat(200));
  await page.getByRole("button", { name: "Look up patient" }).click();
  // Desk stays usable; review panel for the e2e patient must not appear
  await expect(
    page.getByRole("region", {
      name: `#${env("E2E_PATIENT_REG_NO")} · ${env("E2E_PATIENT_NAME")}`,
    }),
  ).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Doctor" })).toBeVisible();
});

/**
 * #50 — Doctor Station: mark seen returns immediately to scanner.
 * Uses a dedicated fixture so earlier suite tests keep a registered patient.
 * Must run after shared-patient lookup tests.
 */
test("doctor mark seen returns to scanner with no dismiss screen", async ({
  page,
}) => {
  const reg = env("E2E_DOCTOR_PATIENT_REG_NO");
  const name = env("E2E_DOCTOR_PATIENT_NAME");

  await loginStaff(page, "doctor");
  await page.getByLabel("Reg no").fill(reg);
  await page.getByRole("button", { name: "Look up patient" }).click();

  const review = page.getByRole("region", {
    name: `#${reg} · ${name}`,
  });
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: "Mark seen" }).click();

  // No success card to dismiss — review region gone, reg field ready.
  await expect(review).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByLabel("Reg no")).toBeEnabled();
  await expect(page.getByLabel("Reg no")).toHaveValue("");
  await expect(page.getByText(`#${reg} marked seen`)).toBeVisible();

  // Re-scan / re-type is refused with existing message shape.
  await page.getByLabel("Reg no").fill(reg);
  await page.getByRole("button", { name: "Look up patient" }).click();
  const again = page.getByRole("region", {
    name: `#${reg} · ${name}`,
  });
  await expect(again).toBeVisible();
  await expect(again.getByText(/Already [Ss]een/)).toBeVisible();
  await expect(again.getByRole("button", { name: "Mark seen" })).toHaveCount(0);
});
