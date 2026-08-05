import { expect, test, type Locator, type Page } from "@playwright/test";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} was not created by E2E global setup.`);
  return value;
}

async function gotoReady(page: Page, path: string, ready: Locator) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(ready).toBeVisible();
}

async function loginStaff(
  page: Page,
  role: "admin" | "team_lead" | "volunteer",
) {
  await gotoReady(page, "/login", page.getByLabel("Email"));
  await page.getByLabel("Email").fill(env(`E2E_${role.toUpperCase()}_EMAIL`));
  await page
    .getByLabel("Password")
    .fill(env(`E2E_${role.toUpperCase()}_PASSWORD`));
  await page.getByRole("button", { name: "Sign in" }).click();
  const landing = role === "team_lead" ? "volunteer" : role;
  await expect(page).toHaveURL(new RegExp(`/${landing}$`));
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

  // Retired desks must not serve an app shell to anyone (ADR 0008).
  for (const retired of ["/doctor", "/counter"]) {
    const res = await request.get(retired);
    expect(
      res.status(),
      `${retired} should be gone, not rendering`,
    ).toBe(404);
  }

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

test("no-JS login shell disables controls and keeps credentials out of the URL", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await blockRemoteRequests(page);
  const marker = "e2e-no-js-password";

  await page.goto(`${env("E2E_BASE_URL")}/login`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("static-login-shell")).toBeVisible();
  await expect(page.getByLabel("Email").first()).toBeDisabled();
  await expect(page.getByLabel("Password").first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "Sign in" }).first()).toBeDisabled();

  const url = new URL(page.url());
  expect(url.search).toBe("");
  expect(url.hash).toBe("");
  expect(`${url.search}${url.hash}`).not.toContain(marker);

  await context.close();
});

test("admin can sign in, inspect the patient desk, and sign out", async ({
  page,
}) => {
  await loginStaff(page, "admin");
  await expect(page.getByRole("heading", { name: "Admin", exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Clinical Desk Accounts" }),
  ).toBeVisible();

  await page.goto("/team-lead");
  await expect(
    page.getByRole("heading", { name: "Clinical Desk Operators" }),
  ).toHaveCount(0);

  await page.goto("/admin/clinical-operators");
  await expect(
    page.getByRole("heading", { name: "Clinical Desk Accounts" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add Clinical Desk Operator" }),
  ).toBeVisible();

  await page.goto("/admin");
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

  await page
    .getByLabel("Registration number or name")
    .fill(env("E2E_PATIENT_REG_NO"));
  await page.getByRole("button", { name: "Search" }).click();
  const review = page.getByRole("region", {
    name: `#${env("E2E_PATIENT_REG_NO")} ${env("E2E_PATIENT_NAME")}`,
  });
  await expect(review).toBeVisible();
  await expect(review.getByTestId("print-prescription")).toBeVisible();

  // A lookup must never change queue state — only Print does (ADR 0008).
  // Asserted as an invariant rather than against an absolute status, because
  // other specs share this fixture patient: whatever the desk offered the
  // first time, it must offer exactly the same thing the second time. If a
  // lookup silently queued the patient, "Print" would become "Reprint" here.
  const firstLabel = await review.getByTestId("print-prescription").innerText();
  const firstHadMarkSeen = await review.getByTestId("mark-seen").count();

  await page.getByRole("button", { name: "Wrong patient" }).click();
  await page
    .getByLabel("Registration number or name")
    .fill(env("E2E_PATIENT_REG_NO"));
  await page.getByRole("button", { name: "Search" }).click();
  await expect(review).toBeVisible();

  expect(await review.getByTestId("print-prescription").innerText()).toBe(
    firstLabel,
  );
  expect(await review.getByTestId("mark-seen").count()).toBe(firstHadMarkSeen);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("Team Lead receives the full volunteer desk and own-team overview", async ({
  page,
}) => {
  await loginStaff(page, "team_lead");
  await expect(
    page.getByRole("heading", { name: "Volunteer desk" }),
  ).toBeVisible();
  await expect(page.getByText("Team Lead Overview", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Team Headcount", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("My team's volunteers", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Codex E2E volunteer", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: "Codex E2E volunteer" })
      .getByText(/\d+ distinct patients/),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /Register/ }).first()).toBeVisible();
  // Every dock link must be reachable for this role — no link may bounce them.
  await expect(page.getByRole("link", { name: /Counter/ })).toHaveCount(0);
});

test("admin volunteer creation offers optional Team Lead assignment", async ({
  page,
}) => {
  await loginStaff(page, "admin");
  await page.goto("/volunteer");
  await page.getByRole("button", { name: "Register new volunteer" }).click();
  const picker = page.getByLabel("Team Lead");
  await expect(picker).toBeVisible();
  await expect(
    picker.getByRole("option", { name: "Unassigned" }),
  ).toHaveCount(1);
  await expect(
    picker.getByRole("option", { name: "Codex E2E team_lead" }),
  ).toHaveCount(1);
  await picker.selectOption({ label: "Codex E2E team_lead" });
  await expect(picker).not.toHaveValue("");
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
    name: `#${env("E2E_PATIENT_REG_NO")} ${env("E2E_PATIENT_NAME")}`,
  });
  await expect(review).toBeVisible({ timeout: 15_000 });

  // A deep-linked scan lands on lookup, not on a mutation — the desk still
  // requires an explicit action before anything changes.
  await expect(review.getByTestId("print-prescription")).toBeVisible();
});

test("garbage reg/QR text fails closed without crashing desk", async ({
  page,
}) => {
  await loginStaff(page, "volunteer");
  await page
    .getByLabel("Registration number or name")
    .fill("not-a-patient!!!!!" + "x".repeat(200));
  await page.getByRole("button", { name: "Search" }).click();
  // Desk stays usable; review panel for the e2e patient must not appear
  await expect(
    page.getByRole("region", {
      name: `#${env("E2E_PATIENT_REG_NO")} ${env("E2E_PATIENT_NAME")}`,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Volunteer desk" }),
  ).toBeVisible();
});

/**
 * D22/D25 — the desk's second action. Uses a dedicated fixture patient so the
 * shared-patient lookup tests above keep an un-seen row to work with.
 * Must run after those tests.
 */
test("volunteer marks a waiting patient seen, and a re-scan is refused", async ({
  page,
}) => {
  const reg = env("E2E_SECOND_PATIENT_REG_NO");
  const name = env("E2E_SECOND_PATIENT_NAME");

  await loginStaff(page, "volunteer");
  await page.getByLabel("Registration number or name").fill(reg);
  await page.getByRole("button", { name: "Search" }).click();

  const review = page.getByRole("region", { name: `#${reg} ${name}` });
  await expect(review).toBeVisible({ timeout: 15_000 });
  await review.getByTestId("mark-seen").click();

  // Review closes, a result card names the patient, and the field is ready again.
  await expect(review).toHaveCount(0, { timeout: 15_000 });
  const result = page.getByTestId("seen-result");
  await expect(result).toBeVisible();
  await expect(result.getByText(`#${reg}`)).toBeVisible();
  await expect(page.getByLabel("Registration number or name")).toBeEnabled();
  await expect(page.getByLabel("Registration number or name")).toHaveValue("");

  // A mis-scan is recoverable within the server-side window (D25).
  await expect(result.getByRole("button", { name: "Undo" })).toBeVisible();

  // Re-scan is refused, says so, and offers no second Mark seen.
  await page.getByRole("button", { name: "Scan next" }).click();
  await page.getByLabel("Registration number or name").fill(reg);
  await page.getByRole("button", { name: "Search" }).click();
  const again = page.getByRole("region", { name: `#${reg} ${name}` });
  await expect(again).toBeVisible({ timeout: 15_000 });
  await expect(again.getByText(/Already seen/)).toBeVisible();
  await expect(again.getByTestId("mark-seen")).toHaveCount(0);
  // Paper is still reprintable for a seen patient — that must not be blocked.
  await expect(again.getByTestId("print-prescription")).toBeVisible();
});
