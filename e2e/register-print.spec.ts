/**
 * #62 — Register-and-Print survives popup blocking, delayed save, auto-retries,
 * closed targets, and exhausted transient failure with explicit Try Again.
 *
 * Success paths mock `register_patient_idempotent` so we exercise the browser
 * print-target contract without polluting reg_no sequences or camp fixtures.
 * Failure paths abort/fulfill the same RPC to prove retry + Try Again UX.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

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

async function loginStaff(page: Page, role: "admin" | "volunteer") {
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

function isRegisterRpc(url: string) {
  return /\/rest\/v1\/rpc\/register_patient_idempotent/i.test(url);
}

/** Preferential handler — register before blockRemote so LIFO hits this first. */
async function mockRegisterSuccess(
  page: Page,
  options: {
    delayMs?: number;
    failTimes?: number;
    onCall?: (body: string) => void;
  } = {},
) {
  const patientId = env("E2E_PATIENT_ID");
  const regNo = Number(env("E2E_PATIENT_REG_NO"));
  const name = env("E2E_PATIENT_NAME");
  let calls = 0;
  const failTimes = options.failTimes ?? 0;

  await page.route("**/*", async (route: Route) => {
    const req = route.request();
    if (!isRegisterRpc(req.url())) {
      await route.continue();
      return;
    }
    calls += 1;
    const body = req.postData() || "";
    options.onCall?.(body);

    if (calls <= failTimes) {
      await route.abort("connectionfailed");
      return;
    }

    if (options.delayMs) {
      await new Promise((r) => setTimeout(r, options.delayMs));
    }

    // PostgREST returns a JSON array for set-returning RPCs.
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: patientId,
          reg_no: regNo,
          full_name: name,
          queue_status: "waiting",
        },
      ]),
    });
  });

  return {
    getCalls: () => calls,
    patientId,
    regNo,
  };
}

async function fillMinimalRegistration(page: Page, fullName: string) {
  await page.getByLabel(/Poora naam/i).fill(fullName);
  await page.getByLabel(/^Umar/i).fill("42");
}

test.beforeEach(async ({ page, context }) => {
  await context.clearCookies();
  await blockRemoteRequests(page);
});

test("delayed success navigates pre-opened print target (no noopener open)", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as Window & {
      __deskOpenArgs?: unknown[][];
      __deskOpenOrig?: typeof window.open;
    };
    w.__deskOpenArgs = [];
    w.__deskOpenOrig = window.open.bind(window);
    window.open = ((...args: Parameters<typeof window.open>) => {
      w.__deskOpenArgs!.push(args);
      return w.__deskOpenOrig!(...args);
    }) as typeof window.open;
  });

  // Two auto-retries then delayed success (covers backoff + gesture expiry).
  const mock = await mockRegisterSuccess(page, {
    failTimes: 2,
    delayMs: 900,
  });

  await loginStaff(page, "volunteer");
  await gotoHydrated(page, "/register");

  const name = `Codex E2E Patient Print Allowed ${Date.now()}`;
  await fillMinimalRegistration(page, name);

  const popupPromise = page.waitForEvent("popup");
  await page.getByTestId("desk-register-submit").click();

  const popup = await popupPromise;
  // First paint is about:blank; after delayed RPC it must land on the slip.
  await popup.waitForURL(
    new RegExp(`/print/${mock.patientId}\\?auto=1`, "i"),
    { timeout: 20_000 },
  );
  await expect(popup.getByTestId("desk-slip-a4")).toBeVisible({
    timeout: 15_000,
  });

  const openArgs = (await page.evaluate(
    () =>
      (window as Window & { __deskOpenArgs?: unknown[][] }).__deskOpenArgs ||
      [],
  )) as unknown[][];

  // 3 RPC attempts (2 transport fails + 1 delayed success).
  expect(mock.getCalls()).toBe(3);

  // Synchronous open used about:blank without noopener feature string.
  expect(openArgs.length).toBeGreaterThanOrEqual(1);
  const first = openArgs[0];
  expect(String(first[0])).toMatch(/about:blank/);
  expect(first[1]).toBe("_blank");
  if (first.length >= 3 && first[2] != null) {
    expect(String(first[2])).not.toMatch(/noopener/i);
  }

  await expect(page.getByTestId("desk-print-recovery")).toBeVisible();
  await expect(page.getByTestId("desk-print-recovery")).toHaveAttribute(
    "data-print-navigated",
    "true",
  );
  await expect(page.getByTestId("desk-print-recovery")).toHaveAttribute(
    "data-patient-id",
    mock.patientId,
  );
  await expect(page.getByTestId("desk-register-flash")).toContainText(
    /Print window open/i,
  );
  // Form reset after success — name cleared, recovery retained.
  await expect(page.getByLabel(/Poora naam/i)).toHaveValue("");
});

test("blocked popup: one registration, recovery Print, never claims window opened", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.open = (() => null) as typeof window.open;
  });

  const mock = await mockRegisterSuccess(page);

  await loginStaff(page, "volunteer");
  await gotoHydrated(page, "/register");

  await fillMinimalRegistration(
    page,
    `Codex E2E Patient Print Blocked ${Date.now()}`,
  );
  await page.getByTestId("desk-register-submit").click();

  await expect(page.getByTestId("desk-print-recovery")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("desk-print-recovery")).toHaveAttribute(
    "data-print-navigated",
    "false",
  );
  await expect(page.getByTestId("desk-register-flash")).toContainText(
    /Print blocked/i,
  );
  await expect(page.getByTestId("desk-register-flash")).not.toContainText(
    /Print window open/i,
  );
  await expect(page.getByTestId("desk-print-recovery-button")).toBeVisible();

  // Exactly one registration RPC — recovery must not re-register.
  expect(mock.getCalls()).toBe(1);

  const patientId = await page
    .getByTestId("desk-print-recovery")
    .getAttribute("data-patient-id");
  expect(patientId).toBe(mock.patientId);

  // Deterministic reprint route without a second register RPC.
  const before = mock.getCalls();
  await page.goto(`/print/${patientId}?auto=1`);
  await expect(page.getByTestId("desk-slip-a4")).toBeVisible({
    timeout: 15_000,
  });
  expect(mock.getCalls()).toBe(before);
});

test("closed pre-opened target leaves recovery Print for same patient", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const orig = window.open.bind(window);
    window.open = ((...args: Parameters<typeof window.open>) => {
      const handle = orig(...args);
      if (handle) {
        try {
          handle.close();
        } catch {
          // ignore
        }
      }
      return handle;
    }) as typeof window.open;
  });

  const mock = await mockRegisterSuccess(page);

  await loginStaff(page, "volunteer");
  await gotoHydrated(page, "/register");

  await fillMinimalRegistration(
    page,
    `Codex E2E Patient Print Closed ${Date.now()}`,
  );
  await page.getByTestId("desk-register-submit").click();

  await expect(page.getByTestId("desk-print-recovery")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("desk-print-recovery")).toHaveAttribute(
    "data-print-navigated",
    "false",
  );
  expect(mock.getCalls()).toBe(1);
  await expect(page.getByTestId("desk-print-recovery-button")).toBeVisible();
  await expect(page.getByTestId("desk-print-recovery")).toHaveAttribute(
    "data-patient-id",
    mock.patientId,
  );
});

test("exhausted transient failure preserves fields and shows Try Again", async ({
  page,
}) => {
  let rpcCalls = 0;
  const requestBodies: string[] = [];

  await page.route("**/*", async (route: Route) => {
    const req = route.request();
    if (isRegisterRpc(req.url())) {
      rpcCalls += 1;
      requestBodies.push(req.postData() || "");
      // Transport-class failure → auto-retry then exhausted copy (#60/#62).
      await route.abort("connectionfailed");
      return;
    }
    await route.continue();
  });

  await loginStaff(page, "volunteer");
  await gotoHydrated(page, "/register");

  const name = `Codex E2E Patient Retry Preserve ${Date.now()}`;
  await fillMinimalRegistration(page, name);
  await page.getByLabel(/Mobile number/i).fill("9876543210");

  await page.getByTestId("desk-register-submit").click();

  await expect(page.getByTestId("desk-register-try-again")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/Could not save.*Try Again/i)).toBeVisible();
  // Three attempts (1 + 2 retries).
  expect(rpcCalls).toBe(3);

  // Fields preserved — form not reset.
  await expect(page.getByLabel(/Poora naam/i)).toHaveValue(name);
  await expect(page.getByLabel(/^Umar/i)).toHaveValue("42");
  await expect(page.getByLabel(/Mobile number/i)).toHaveValue("9876543210");

  // Same request id on every attempt.
  const ids = requestBodies.map((body) => {
    try {
      const parsed = JSON.parse(body) as { p_request_id?: string };
      return parsed.p_request_id;
    } catch {
      return null;
    }
  });
  expect(ids[0]).toBeTruthy();
  assertAllSame(ids);

  // Try Again reuses the same request id (3 more aborts).
  const idBefore = ids[0];
  await page.getByTestId("desk-register-try-again").click();
  await expect(page.getByTestId("desk-register-try-again")).toBeVisible({
    timeout: 15_000,
  });
  expect(rpcCalls).toBe(6);
  const moreIds = requestBodies.slice(3).map((body) => {
    const parsed = JSON.parse(body) as { p_request_id?: string };
    return parsed.p_request_id;
  });
  for (const id of moreIds) {
    expect(id).toBe(idBefore);
  }

  // No false success / recovery without a save.
  await expect(page.getByTestId("desk-print-recovery")).toHaveCount(0);
});

test("terminal business error is not auto-retried and has no connectivity Try Again", async ({
  page,
}) => {
  let rpcCalls = 0;
  await page.route("**/*", async (route: Route) => {
    const req = route.request();
    if (isRegisterRpc(req.url())) {
      rpcCalls += 1;
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          code: "P0001",
          message: "This day is full (40 seats). Choose another day.",
          details: null,
          hint: null,
        }),
      });
      return;
    }
    await route.continue();
  });

  await loginStaff(page, "volunteer");
  await gotoHydrated(page, "/register");
  await fillMinimalRegistration(
    page,
    `Codex E2E Patient Full Day ${Date.now()}`,
  );
  await page.getByTestId("desk-register-submit").click();

  await expect(page.getByText(/full|another day/i)).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("desk-register-try-again")).toHaveCount(0);
  await expect(page.getByText(/Could not save.*internet/i)).toHaveCount(0);
  expect(rpcCalls).toBe(1);
});

function assertAllSame(values: (string | null | undefined)[]) {
  const first = values[0];
  for (const v of values) {
    expect(v).toBe(first);
  }
}
