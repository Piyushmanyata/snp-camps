import { expect, test, type Page } from "@playwright/test";

// Intentionally generous for a loaded CI host. The network profile is roughly
// a constrained 4G connection and includes deferred scanner chunk/worker load.
const DESK_ACTION_BUDGET_MS = 15_000;

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} was not created by E2E setup.`);
  return value;
}

async function loginVolunteer(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(env("E2E_VOLUNTEER_EMAIL"));
  await page.getByLabel("Password").fill(env("E2E_VOLUNTEER_PASSWORD"));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/volunteer$/);
  await page.goto("/register");
  await page.waitForLoadState("networkidle");
}

test.describe("throttled primary desk action", () => {
  test.describe.configure({ mode: "serial" });

  test("camera scan → registered → print is within the 15 second budget", async ({
    page,
    context,
  }) => {
    env("E2E_FAKE_CAMERA_PATH");
    await loginVolunteer(page);

    const patientId = env("E2E_PATIENT_ID");
    const regNo = Number(env("E2E_PATIENT_REG_NO"));
    await page.route("**/api/desk/register-scanned", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              id: patientId,
              reg_no: regNo,
              full_name: "Timing Patient",
              queue_status: "waiting",
            },
          ],
          error: null,
        }),
      });
    });

    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 150,
      downloadThroughput: 200_000,
      uploadThroughput: 95_000,
      connectionType: "cellular4g",
    });

    const startedAt = performance.now();
    try {
      await page.getByTestId("scan-aadhaar-qr-button").click();
      await expect(page.getByTestId("aadhaar-scanned-banner")).toBeVisible({
        timeout: DESK_ACTION_BUDGET_MS,
      });
      await page.getByLabel(/Mobile number/i).fill("9876543210");

      const popupPromise = page.waitForEvent("popup");
      await page.getByTestId("desk-register-submit").click();
      const popup = await popupPromise;
      await popup.waitForURL(new RegExp(`/print/${patientId}\\?auto=1`), {
        timeout: DESK_ACTION_BUDGET_MS,
      });
      await expect(popup.getByTestId("desk-slip-thermal")).toBeVisible({
        timeout: DESK_ACTION_BUDGET_MS,
      });
    } finally {
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
        connectionType: "none",
      });
    }

    const elapsedMs = performance.now() - startedAt;
    expect(
      elapsedMs,
      `scan-to-printed took ${Math.round(elapsedMs)}ms`,
    ).toBeLessThan(DESK_ACTION_BUDGET_MS);
  });
});
