import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

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

async function cleanupTimingIdentity() {
  const admin = createClient(
    env("E2E_SUPABASE_URL"),
    env("E2E_SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const existing = await admin
    .from("patients")
    .select("id, person_id")
    .eq("camp_id", env("E2E_CAMP_ID"))
    .eq("full_name", "Timing Patient");
  if (existing.error) {
    throw new Error(`Timing patient lookup failed: ${existing.error.message}`);
  }

  const patientIds = (existing.data ?? []).map((row) => row.id);
  const personIds = [
    ...new Set(
      (existing.data ?? [])
        .map((row) => row.person_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (patientIds.length > 0) {
    const patients = await admin.from("patients").delete().in("id", patientIds);
    if (patients.error) {
      throw new Error(`Timing patient cleanup failed: ${patients.error.message}`);
    }
  }

  // Also clear an orphan left by an interrupted prior local run, but never
  // delete a Person that still owns a registration in any Camp.
  const possibleOrphans = await admin
    .from("persons")
    .select("id")
    .eq("full_name", "Timing Patient");
  if (possibleOrphans.error) {
    throw new Error(
      `Timing Person lookup failed: ${possibleOrphans.error.message}`,
    );
  }
  for (const row of possibleOrphans.data ?? []) {
    if (!personIds.includes(row.id)) personIds.push(row.id);
  }
  for (const personId of personIds) {
    const registrations = await admin
      .from("patients")
      .select("id", { count: "exact", head: true })
      .eq("person_id", personId);
    if (registrations.error) {
      throw new Error(
        `Timing Person registration check failed: ${registrations.error.message}`,
      );
    }
    if ((registrations.count ?? 0) === 0) {
      const person = await admin.from("persons").delete().eq("id", personId);
      if (person.error) {
        throw new Error(`Timing Person cleanup failed: ${person.error.message}`);
      }
    }
  }
}

test.describe("throttled primary desk action", () => {
  test.describe.configure({ mode: "serial" });
  test.afterEach(async () => {
    await cleanupTimingIdentity();
  });

  test("camera scan → registered → print is within the 15 second budget", async ({
    page,
    context,
  }) => {
    test.setTimeout(45_000);
    env("E2E_FAKE_CAMERA_PATH");
    await cleanupTimingIdentity();
    await context.addInitScript(() => {
      Object.defineProperty(window, "print", {
        configurable: true,
        value: () => {
          document.documentElement.dataset.printCalled = "true";
        },
      });
    });
    await loginVolunteer(page);

    const cdp = await context.newCDPSession(page);
    const throttle = async (session: typeof cdp) => {
      await session.send("Network.enable");
      await session.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 150,
        downloadThroughput: 200_000,
        uploadThroughput: 95_000,
        connectionType: "cellular4g",
      });
    };
    await throttle(cdp);

    const popupCdpRef: { current: CDPSession | null } = { current: null };
    const popupThrottleReady = new Promise<void>((resolve, reject) => {
      context.once("page", async (popupPage) => {
        try {
          popupCdpRef.current = await context.newCDPSession(popupPage);
          await throttle(popupCdpRef.current);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });

    const startedAt = performance.now();
    try {
      await page.getByTestId("scan-aadhaar-qr-button").click();
      await expect(page.getByTestId("aadhaar-scanned-banner")).toBeVisible({
        timeout: DESK_ACTION_BUDGET_MS,
      });
      await page.getByLabel(/Mobile number/i).fill("9876543210");

      const popupPromise = page.waitForEvent("popup");
      const registrationResponsePromise = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/desk/register-scanned") &&
          response.request().method() === "POST",
      );
      const printResponsePromise = new Promise<import("@playwright/test").Response>(
        (resolve) => {
          const onResponse = (
            response: import("@playwright/test").Response,
          ) => {
            if (
              /\/api\/patients\/[0-9a-f-]+\/print$/.test(response.url()) &&
              response.request().method() === "POST"
            ) {
              context.off("response", onResponse);
              resolve(response);
            }
          };
          context.on("response", onResponse);
        },
      );
      await page.getByTestId("desk-register-submit").click();
      const [popup, registrationResponse] = await Promise.all([
        popupPromise,
        registrationResponsePromise,
      ]);
      expect(registrationResponse.status()).toBe(200);
      await popupThrottleReady;
      await popup.waitForURL(/\/print\/[0-9a-f-]+\?auto=1$/, {
        timeout: DESK_ACTION_BUDGET_MS,
      });
      await expect(popup.getByTestId("desk-slip-thermal")).toBeVisible({
        timeout: DESK_ACTION_BUDGET_MS,
      });
      const printResponse = await printResponsePromise;
      expect(printResponse.status()).toBe(200);
      await expect(
        popup.getByText(/The print dialog is open\./i),
      ).toBeVisible({ timeout: DESK_ACTION_BUDGET_MS });
      await expect
        .poll(
          () =>
            popup.evaluate(
              () => document.documentElement.dataset.printCalled === "true",
            ),
          { timeout: DESK_ACTION_BUDGET_MS },
        )
        .toBe(true);
    } finally {
      if (!page.isClosed()) {
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
          connectionType: "none",
        });
      }
      if (popupCdpRef.current) {
        await popupCdpRef.current.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
          connectionType: "none",
        });
      }
    }

    const elapsedMs = performance.now() - startedAt;
    expect(
      elapsedMs,
      `scan-to-printed took ${Math.round(elapsedMs)}ms`,
    ).toBeLessThan(DESK_ACTION_BUDGET_MS);
  });
});
