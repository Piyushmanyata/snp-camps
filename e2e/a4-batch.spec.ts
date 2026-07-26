/**
 * #64 — A4 batches four distinct patients; thermal remains one-up.
 * Geometry asserts print media / PDF, not only screen DOM screenshots.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const scratchDir = path.join(process.cwd(), ".scratch", "remediation-64");
const samplesDir = path.join(process.cwd(), "docs", "desk-slip-samples");

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} was not created by E2E global setup.`);
  return value;
}

async function gotoHydrated(page: Page, pathName: string) {
  await page.goto(pathName);
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

async function fillMinimalRegistration(page: Page, fullName: string, age: number = 42) {
  await page.getByLabel(/Poora naam/i).fill(fullName);
  await page.getByLabel(/^Umar/i).fill(String(age));
}

test.beforeEach(async ({ page, context }) => {
  await context.clearCookies();
  await blockRemoteRequests(page);
  // Default station to A4 multi-up for batch tests.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("snp.deskSlipFormat", "a4");
      window.localStorage.removeItem("snp.a4BatchQueue");
    } catch {
      // ignore
    }
  });
});

test("four sequential A4 registrations → one sheet with four distinct slips", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  // Real RPC (not mock) so batch print can load four authorized rows.
  await loginStaff(page, "volunteer");
  await gotoHydrated(page, "/register");

  const tag = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const names = [1, 2, 3, 4].map(
    (n) => `Codex E2E Batch Distinct ${n} ${tag}`,
  );

  for (let i = 0; i < 4; i += 1) {
    await fillMinimalRegistration(page, names[i]!, 20 + i * 5);
    await page.getByTestId("desk-register-submit").click();
    await expect(page.getByTestId("a4-batch-panel")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("a4-batch-panel")).toHaveAttribute(
      "data-batch-count",
      String(i + 1),
    );
    await expect(page.getByLabel(/Poora naam/i)).toHaveValue("");
    await expect(page.getByTestId("desk-register-submit")).toBeEnabled();
  }

  await expect(page.getByTestId("a4-batch-panel")).toHaveAttribute(
    "data-batch-full",
    "true",
  );
  await expect(page.getByTestId("a4-batch-id")).toHaveCount(4);

  // Storage holds only ids + timestamps (no PII keys).
  const stored = await page.evaluate(() => {
    const raw = window.localStorage.getItem("snp.a4BatchQueue");
    return raw ? JSON.parse(raw) : null;
  });
  expect(stored?.entries?.length).toBe(4);
  for (const e of stored.entries) {
    expect(Object.keys(e).sort()).toEqual(["addedAt", "id"]);
    expect(e.full_name).toBeUndefined();
    expect(e.phone).toBeUndefined();
    expect(e.status_token).toBeUndefined();
  }
  const ids = stored.entries.map((e: { id: string }) => e.id) as string[];
  expect(new Set(ids).size).toBe(4);

  await expect(page.getByTestId("desk-register-flash")).toContainText(
    /A4 sheet full/i,
  );

  // Open batch sheet (user-gesture Print) and assert four distinct cells.
  const popupPromise = context.waitForEvent("page");
  await page.getByTestId("a4-batch-print-now").click();
  const sheet = await popupPromise;
  await sheet.waitForLoadState("networkidle");
  await expect(sheet.getByTestId("desk-slip-a4")).toBeVisible({
    timeout: 20_000,
  });
  await expect(sheet.getByTestId("desk-slip-a4")).toHaveAttribute(
    "data-slip-count",
    "4",
  );
  await expect(sheet.getByTestId("desk-slip-a4-cell")).toHaveCount(4);
  await expect(sheet.getByTestId("desk-slip-a4-cell-empty")).toHaveCount(0);
  await expect(sheet.getByTestId("desk-slip-reg-no")).toHaveCount(4);
  await expect(sheet.getByTestId("desk-slip-name")).toHaveCount(4);

  const cellIds = await sheet
    .locator('[data-testid="desk-slip-a4-cell"]')
    .evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("data-patient-id") || ""),
    );
  expect(new Set(cellIds).size).toBe(4);
  for (const id of ids) {
    expect(cellIds.map((c) => c.toLowerCase())).toContain(id.toLowerCase());
  }

  const qrValues = await sheet
    .locator('[data-testid="desk-slip-qr"]')
    .evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("data-qr-value") || ""),
    );
  expect(new Set(qrValues).size).toBe(4);
  for (const q of qrValues) {
    expect(q).toMatch(/^snp:/i);
  }

  const shownNames = await sheet
    .locator('[data-testid="desk-slip-name"]')
    .allTextContents();
  for (const n of names) {
    expect(shownNames.some((s) => s.includes(n))).toBe(true);
  }

  // Print-media geometry on the full sheet
  await sheet.emulateMedia({ media: "print" });
  fs.mkdirSync(scratchDir, { recursive: true });
  fs.mkdirSync(samplesDir, { recursive: true });
  await sheet.pdf({
    path: path.join(scratchDir, "a4-four-distinct.pdf"),
    format: "A4",
    printBackground: true,
  });
  await sheet
    .getByTestId("desk-slip-a4")
    .screenshot({ path: path.join(samplesDir, "a4-multi-up.png") });
});

test("partial A4 batch Print now opens sheet with empty cells, no duplicates", async ({
  page,
}) => {
  // Seed real fixture patient + two mocked extras via batch URL using fixture id thrice would be wrong —
  // use single fixture patient once via batch?ids= only one id.
  const patientId = env("E2E_PATIENT_ID");
  await loginStaff(page, "volunteer");

  await gotoHydrated(
    page,
    `/print/batch?ids=${encodeURIComponent(patientId)}`,
  );

  await expect(page.getByTestId("desk-slip-a4")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("desk-slip-a4")).toHaveAttribute(
    "data-slip-count",
    "1",
  );
  await expect(page.getByTestId("desk-slip-a4-cell")).toHaveCount(1);
  await expect(page.getByTestId("desk-slip-a4-cell-empty")).toHaveCount(3);
  await expect(page.getByTestId("desk-slip-reg-no")).toHaveCount(1);

  // Distinct patient id on the filled cell only
  const cellId = await page
    .getByTestId("desk-slip-a4-cell")
    .first()
    .getAttribute("data-patient-id");
  expect(cellId).toBe(patientId.toLowerCase());

  // Batch chrome present
  await expect(page.getByTestId("print-actions")).toHaveAttribute(
    "data-batch",
    "true",
  );
  await expect(page.getByTestId("print-start-next-sheet")).toBeVisible();
});

test("thermal registration opens one-up print path immediately", async ({
  page,
}) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("snp.deskSlipFormat", "thermal58");
    } catch {
      // ignore
    }
  });

  const patientId = env("E2E_PATIENT_ID");
  let calls = 0;
  await page.route("**/*", async (route: Route) => {
    const req = route.request();
    if (!isRegisterRpc(req.url())) {
      await route.continue();
      return;
    }
    calls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: patientId,
          reg_no: Number(env("E2E_PATIENT_REG_NO")),
          full_name: env("E2E_PATIENT_NAME"),
          queue_status: "waiting",
        },
      ]),
    });
  });

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

  await loginStaff(page, "volunteer");
  await gotoHydrated(page, "/register");
  await fillMinimalRegistration(page, `Codex E2E Thermal Immediate ${Date.now()}`);

  const popupPromise = page.waitForEvent("popup");
  await page.getByTestId("desk-register-submit").click();
  const popup = await popupPromise;
  await popup.waitForURL(new RegExp(`/print/${patientId}\\?auto=1`, "i"), {
    timeout: 20_000,
  });
  // Thermal format may still need a click if server snapshot was a4 — force thermal.
  const thermalBtn = popup.getByRole("button", { name: "58mm thermal" });
  if (await thermalBtn.isVisible().catch(() => false)) {
    // Format is station localStorage — already thermal58 from init.
  }
  await expect(popup.getByTestId("desk-slip-thermal")).toBeVisible({
    timeout: 15_000,
  });
  await expect(popup.getByTestId("desk-slip-reg-no")).toHaveCount(1);
  expect(calls).toBe(1);
});

test("max-length name and venue wrap without clipping QR (print media + PDF)", async ({
  page,
}) => {
  const patientId = env("E2E_PATIENT_ID");
  // 120-char name fixture injected into DOM via evaluate after load is brittle;
  // instead open print and override text content for geometry only.
  await loginStaff(page, "volunteer");
  await gotoHydrated(page, `/print/${patientId}`);

  const maxName = "A".repeat(120);
  const maxVenue =
    "Community Ground Behind Municipal Hall Ward 12 Sector Extension Block C";

  await page.evaluate(
    ({ maxName: n, maxVenue: v }) => {
      for (const el of document.querySelectorAll(
        '[data-testid="desk-slip-name"]',
      )) {
        el.textContent = n;
      }
      for (const el of document.querySelectorAll(
        '[data-testid="desk-slip-venue"]',
      )) {
        el.innerHTML = `<span class="font-semibold">Venue</span> ${v}`;
      }
    },
    { maxName, maxVenue },
  );

  await page.emulateMedia({ media: "print" });

  const result = await page.evaluate(() => {
    const sheet = document.querySelector(
      '[data-testid="desk-slip-a4"]',
    ) as HTMLElement | null;
    const qr = document.querySelector(
      '[data-testid="desk-slip-qr"]',
    ) as HTMLElement | null;
    const name = document.querySelector(
      '[data-testid="desk-slip-name"]',
    ) as HTMLElement | null;
    if (!sheet || !qr || !name) return { ok: false as const };
    const sb = sheet.getBoundingClientRect();
    const qb = qr.getBoundingClientRect();
    const nb = name.getBoundingClientRect();
    const sheetStyle = getComputedStyle(sheet);
    return {
      ok: true as const,
      nameLen: (name.textContent || "").length,
      qrInside:
        qb.left >= sb.left - 2 &&
        qb.right <= sb.right + 2 &&
        qb.top >= sb.top - 2 &&
        qb.bottom <= sb.bottom + 2,
      nameNotOverflowX: nb.right <= sb.right + 2,
      overflow: sheetStyle.overflow,
      qrValue: qr.getAttribute("data-qr-value"),
    };
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.nameLen).toBe(120);
  expect(result.qrInside).toBe(true);
  expect(result.nameNotOverflowX).toBe(true);
  expect(result.overflow === "hidden").toBe(false);
  expect(result.qrValue).toMatch(/^snp:/i);

  fs.mkdirSync(scratchDir, { recursive: true });
  fs.mkdirSync(samplesDir, { recursive: true });
  await page.pdf({
    path: path.join(scratchDir, "a4-max-content.pdf"),
    format: "A4",
    printBackground: true,
  });
  await page
    .getByTestId("desk-slip-a4")
    .screenshot({ path: path.join(samplesDir, "a4-multi-up.png") });
});

test("Start next sheet clears station batch storage", async ({ page }) => {
  const patientId = env("E2E_PATIENT_ID");
  await page.addInitScript((id) => {
    try {
      window.localStorage.setItem(
        "snp.a4BatchQueue",
        JSON.stringify({
          v: 1,
          entries: [{ id, addedAt: Date.now() }],
        }),
      );
      window.localStorage.setItem("snp.deskSlipFormat", "a4");
    } catch {
      // ignore
    }
  }, patientId);

  await loginStaff(page, "volunteer");
  await gotoHydrated(
    page,
    `/print/batch?ids=${encodeURIComponent(patientId)}`,
  );
  await expect(page.getByTestId("desk-slip-a4")).toBeVisible();
  await page.getByTestId("print-start-next-sheet").click();

  const after = await page.evaluate(() =>
    window.localStorage.getItem("snp.a4BatchQueue"),
  );
  const parsed = after ? JSON.parse(after) : null;
  expect(parsed?.entries?.length ?? 0).toBe(0);
});
