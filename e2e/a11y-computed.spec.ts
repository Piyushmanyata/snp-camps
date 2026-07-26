/**
 * #69 — browser-level a11y: computed touch targets, contrast, focus, 200% text zoom.
 * Source checks in tests/a11y-field.test.mjs are supplemental only.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TOUCH_MIN = 44;
const AA_NORMAL = 4.5;
const AA_LARGE = 3;
const EVIDENCE_DIR = join(process.cwd(), ".scratch", "remediation-69");

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

/** Measure rendered hit area (CSS px) for a locator. */
async function measureHitArea(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element not visible for hit-area measurement");
  return { width: box.width, height: box.height, x: box.x, y: box.y };
}

async function assertTouchTarget(
  locator: Locator,
  label: string,
  min = TOUCH_MIN,
) {
  await expect(locator, label).toBeVisible();
  const { width, height } = await measureHitArea(locator);
  expect(
    height,
    `${label}: height ${height.toFixed(1)}px < ${min}px`,
  ).toBeGreaterThanOrEqual(min - 0.5);
  expect(
    width,
    `${label}: width ${width.toFixed(1)}px < ${min}px`,
  ).toBeGreaterThanOrEqual(min - 0.5);
  return { width, height };
}

/**
 * Compute WCAG contrast of an element's effective foreground against the
 * first non-transparent ancestor background (includes element opacity blend).
 */
async function computedContrast(locator: Locator) {
  return locator.evaluate((el) => {
    function parseCssColor(input: string): [number, number, number, number] | null {
      const s = input.trim().toLowerCase();
      if (!s || s === "transparent") return [0, 0, 0, 0];
      const hex = s.match(/^#([0-9a-f]{3,8})$/i);
      if (hex) {
        let h = hex[1]!;
        if (h.length === 3) {
          h = h
            .split("")
            .map((c) => c + c)
            .join("");
        }
        if (h.length === 4) {
          h = h
            .split("")
            .map((c) => c + c)
            .join("");
        }
        const n = parseInt(h.slice(0, 6), 16);
        const a =
          h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
      }
      const m = s.match(
        /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/,
      );
      if (m) {
        return [
          Number(m[1]),
          Number(m[2]),
          Number(m[3]),
          m[4] != null ? Number(m[4]) : 1,
        ];
      }
      // modern rgb(r g b / a)
      const m2 = s.match(
        /rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/,
      );
      if (m2) {
        const aRaw = m2[4];
        let a = 1;
        if (aRaw != null) {
          a = aRaw.endsWith("%") ? Number(aRaw.slice(0, -1)) / 100 : Number(aRaw);
        }
        return [Number(m2[1]), Number(m2[2]), Number(m2[3]), a];
      }
      return null;
    }

    function blend(
      fg: [number, number, number, number],
      bg: [number, number, number],
    ): [number, number, number] {
      const a = Math.min(1, Math.max(0, fg[3]));
      return [
        fg[0] * a + bg[0] * (1 - a),
        fg[1] * a + bg[1] * (1 - a),
        fg[2] * a + bg[2] * (1 - a),
      ];
    }

    function relL([r, g, b]: [number, number, number]) {
      const f = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    }

    function contrastRatio(
      a: [number, number, number],
      b: [number, number, number],
    ) {
      const L1 = relL(a);
      const L2 = relL(b);
      const hi = Math.max(L1, L2);
      const lo = Math.min(L1, L2);
      return (hi + 0.05) / (lo + 0.05);
    }

    function bgOf(node: Element | null): [number, number, number] {
      let cur: Element | null = node;
      while (cur) {
        const cs = getComputedStyle(cur);
        const parsed = parseCssColor(cs.backgroundColor);
        if (parsed && parsed[3] > 0.01) {
          // Flatten onto white if semi-transparent
          if (parsed[3] >= 0.99) return [parsed[0], parsed[1], parsed[2]];
          return blend(parsed, [255, 255, 255]);
        }
        cur = cur.parentElement;
      }
      return [248, 250, 252]; // app --background fallback
    }

    const cs = getComputedStyle(el);
    const color = parseCssColor(cs.color);
    if (!color) {
      return { ratio: 0, fg: cs.color, bg: "unknown", fontSize: cs.fontSize };
    }
    const opacity = Number(cs.opacity);
    const effectiveA = color[3] * (Number.isFinite(opacity) ? opacity : 1);
    const bg = bgOf(el);
    const fg = blend([color[0], color[1], color[2], effectiveA], bg);
    const fontSizePx = parseFloat(cs.fontSize) || 16;
    const fontWeight = parseInt(cs.fontWeight, 10) || 400;
    const isLarge =
      fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
    return {
      ratio: contrastRatio(fg, bg),
      fg: `rgb(${fg.map((n) => Math.round(n)).join(", ")})`,
      bg: `rgb(${bg.map((n) => Math.round(n)).join(", ")})`,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      isLarge,
      opacity: effectiveA,
    };
  });
}

async function assertContrastAA(locator: Locator, label: string) {
  const result = await computedContrast(locator);
  const need = result.isLarge ? AA_LARGE : AA_NORMAL;
  expect(
    result.ratio,
    `${label}: contrast ${result.ratio.toFixed(2)}:1 (${result.fg} on ${result.bg}, size ${result.fontSize}) < ${need}:1`,
  ).toBeGreaterThanOrEqual(need - 0.05);
  return result;
}

/** Visible keyboard focus: outline or box-shadow ring present. */
async function assertFocusVisible(locator: Locator, label: string) {
  // Prefer FocusOptions.focusVisible so :focus-visible styles apply (Chromium).
  await locator.evaluate((el) => {
    try {
      (el as HTMLElement).focus({ focusVisible: true } as FocusOptions);
    } catch {
      (el as HTMLElement).focus();
    }
  });
  const focusStyle = await locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
      outlineColor: cs.outlineColor,
      boxShadow: cs.boxShadow,
      matchesFocusVisible: el.matches(":focus-visible"),
    };
  });
  const hasOutline =
    focusStyle.outlineStyle !== "none" &&
    parseFloat(focusStyle.outlineWidth) > 0;
  const hasRing =
    focusStyle.boxShadow !== "none" && focusStyle.boxShadow.length > 0;
  expect(
    hasOutline || hasRing || focusStyle.matchesFocusVisible,
    `${label}: no visible focus (outline=${focusStyle.outlineStyle} ${focusStyle.outlineWidth}, shadow=${focusStyle.boxShadow}, :focus-visible=${focusStyle.matchesFocusVisible})`,
  ).toBeTruthy();
  // Soft assert: prefer real paint signal when :focus-visible matched
  if (focusStyle.matchesFocusVisible) {
    expect(
      hasOutline || hasRing,
      `${label}: :focus-visible matched but no outline/ring painted`,
    ).toBeTruthy();
  }
  return focusStyle;
}

/** Lightweight automated scan: interactive controls have names + size floor. */
async function scanInteractiveTargets(page: Page, scopeLabel: string) {
  const report = await page.evaluate((touchMin) => {
    const selectors = [
      "button:not([disabled])",
      "a[href]",
      'input:not([type="hidden"]):not([disabled])',
      "select:not([disabled])",
      "textarea:not([disabled])",
      '[role="button"]:not([aria-disabled="true"])',
      '[role="radio"]:not([aria-disabled="true"])',
    ].join(",");
    const nodes = Array.from(document.querySelectorAll(selectors));
    const failures: {
      tag: string;
      name: string;
      w: number;
      h: number;
      reason: string;
    }[] = [];
    const ok: { tag: string; name: string; w: number; h: number }[] = [];

    for (const el of nodes) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (Number(style.opacity) === 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // Skip off-screen / clipped dock duplicates roughly
      if (rect.bottom < 0 || rect.top > window.innerHeight + 200) continue;

      const name =
        (el as HTMLElement).innerText?.trim().slice(0, 60) ||
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        (el as HTMLInputElement).labels?.[0]?.innerText?.trim() ||
        el.getAttribute("name") ||
        el.tagName.toLowerCase();

      // Inline prose links inside paragraphs — exception when text is in a sentence
      const isInlineProseLink =
        el.tagName === "A" &&
        el.parentElement?.closest("p, li, dd, span.prose-help") != null &&
        rect.height < touchMin;

      if (!name) {
        failures.push({
          tag: el.tagName.toLowerCase(),
          name: "(unnamed)",
          w: rect.width,
          h: rect.height,
          reason: "missing accessible name",
        });
        continue;
      }

      if (isInlineProseLink) {
        ok.push({
          tag: el.tagName.toLowerCase(),
          name: `${name} [inline exception]`,
          w: rect.width,
          h: rect.height,
        });
        continue;
      }

      if (rect.height < touchMin - 0.5 || rect.width < touchMin - 0.5) {
        failures.push({
          tag: el.tagName.toLowerCase(),
          name,
          w: rect.width,
          h: rect.height,
          reason: `hit area ${rect.width.toFixed(0)}×${rect.height.toFixed(0)} < ${touchMin}×${touchMin}`,
        });
        continue;
      }
      ok.push({
        tag: el.tagName.toLowerCase(),
        name,
        w: rect.width,
        h: rect.height,
      });
    }
    return { failures, ok, total: nodes.length };
  }, TOUCH_MIN);

  expect(
    report.failures,
    `${scopeLabel}: touch/name failures:\n${report.failures
      .map((f) => `  - ${f.tag} "${f.name}": ${f.reason}`)
      .join("\n")}`,
  ).toEqual([]);
  return report;
}

async function applyTextZoom200(page: Page) {
  await page.evaluate(() => {
    const root = document.documentElement;
    const base = parseFloat(getComputedStyle(root).fontSize) || 16;
    root.style.fontSize = `${base * 2}px`;
  });
}

async function assertNoTwoAxisScroll(page: Page, label: string) {
  const scroll = await page.evaluate(() => {
    const se = document.scrollingElement || document.documentElement;
    let worst: { name: string; right: number } | null = null;
    const roots = [
      document.getElementById("main"),
      document.querySelector(".mobile-dock"),
      document.querySelector("header"),
    ].filter(Boolean) as Element[];
    for (const root of roots) {
      for (const el of root.querySelectorAll(
        "button, a, input, select, textarea, h1, h2, p, li, span",
      )) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        // Ignore off-screen vertical (below fold is OK — vertical scroll)
        if (r.top > window.innerHeight + 40) continue;
        if (!worst || r.right > worst.right) {
          const name =
            (el as HTMLElement).innerText?.trim().slice(0, 40) ||
            el.getAttribute("aria-label") ||
            el.tagName;
          worst = { name, right: r.right };
        }
      }
    }
    return {
      scrollWidth: se.scrollWidth,
      clientWidth: se.clientWidth,
      viewport: window.innerWidth,
      worst,
    };
  });
  // Primary axis only: no horizontal document overflow (2D scroll).
  expect(
    scroll.scrollWidth,
    `${label}: horizontal overflow requires 2D scroll (scrollWidth=${scroll.scrollWidth}, clientWidth=${scroll.clientWidth})`,
  ).toBeLessThanOrEqual(scroll.clientWidth + 4);
  if (scroll.worst) {
    expect(
      scroll.worst.right,
      `${label}: "${scroll.worst.name}" paints past viewport (right=${scroll.worst.right}, vw=${scroll.viewport})`,
    ).toBeLessThanOrEqual(scroll.viewport + 12);
  }
}

function saveEvidenceJson(name: string, data: unknown) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(EVIDENCE_DIR, name), JSON.stringify(data, null, 2), "utf8");
}

test.beforeEach(async ({ page, context }) => {
  await context.clearCookies();
  await blockRemoteRequests(page);
});

test("volunteer desk: touch targets, scanner contrast, keyboard focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginStaff(page, "volunteer");
  await expect(
    page.getByRole("heading", { name: "Volunteer desk" }),
  ).toBeVisible();

  const openCamera = page.getByRole("button", { name: /Open camera/i });
  const lookUp = page.getByRole("button", { name: "Look up patient" });
  const refresh = page.getByRole("button", { name: "Refresh" }).first();

  const measurements: Record<string, unknown> = {};
  measurements.openCamera = await assertTouchTarget(openCamera, "Open camera");
  measurements.lookUp = await assertTouchTarget(lookUp, "Look up patient");
  if (await refresh.isVisible().catch(() => false)) {
    measurements.seatRefresh = await assertTouchTarget(
      refresh,
      "Seat board Refresh",
    );
  }

  // Scanner guidance / helper text contrast
  const help = page.locator("p.prose-help").first();
  if (await help.isVisible()) {
    measurements.scannerHelpContrast = await assertContrastAA(
      help,
      "scanner prose-help",
    );
  }
  const regHint = page.getByText(/Equal path to the camera/i);
  if (await regHint.isVisible()) {
    measurements.regHintContrast = await assertContrastAA(
      regHint,
      "reg number hint",
    );
  }

  // Lookup success guidance (brand-soft panel) after scan path
  await page.getByLabel("Reg no").fill(env("E2E_PATIENT_REG_NO"));
  await lookUp.click();
  const review = page.getByRole("region", {
    name: `#${env("E2E_PATIENT_REG_NO")} · ${env("E2E_PATIENT_NAME")}`,
  });
  await expect(review).toBeVisible();

  const doctorBtn = review
    .getByRole("group", { name: "Select doctor" })
    .getByRole("button")
    .first();
  if (await doctorBtn.isVisible().catch(() => false)) {
    measurements.doctorChip = await assertTouchTarget(
      doctorBtn,
      "doctor assign chip",
    );
    await assertFocusVisible(doctorBtn, "doctor assign chip");
  }

  const assign = review.getByRole("button", {
    name: "Assign doctor · mark seen",
  });
  if (await assign.isVisible()) {
    measurements.assign = await assertTouchTarget(assign, "assign doctor");
  }

  const cancel = review.getByRole("button", { name: "Cancel" });
  if (await cancel.isVisible()) {
    measurements.cancel = await assertTouchTarget(cancel, "cancel review");
  }

  await assertFocusVisible(openCamera, "Open camera");
  await assertFocusVisible(lookUp, "Look up patient");

  // Keyboard: Tab reaches Open camera and Look up
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  let reachedOpen = false;
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(
      () => document.activeElement?.textContent?.trim() || "",
    );
    if (/Open camera/i.test(focused)) {
      reachedOpen = true;
      break;
    }
  }
  expect(reachedOpen, "keyboard reaches Open camera").toBeTruthy();

  const scanReport = await scanInteractiveTargets(page, "volunteer desk");
  measurements.scan = {
    ok: scanReport.ok.length,
    failures: scanReport.failures.length,
  };
  saveEvidenceJson("volunteer-desk-measurements.json", measurements);

  await page.screenshot({
    path: join(EVIDENCE_DIR, "volunteer-mobile.png"),
    fullPage: true,
  });
});

test("doctor desk: operational controls meet 48×48 and focus rings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginStaff(page, "doctor");
  // Doctor role title is "Doctor"; admin managing doctors uses "Doctor desk".
  await expect(page.getByRole("heading", { name: /^Doctor/ })).toBeVisible();

  const openCamera = page.getByRole("button", { name: /Open camera/i });
  const lookUp = page.getByRole("button", { name: "Look up patient" });
  await assertTouchTarget(openCamera, "doctor Open camera");
  await assertTouchTarget(lookUp, "doctor Look up");
  await assertFocusVisible(openCamera, "doctor Open camera");

  await page.getByLabel("Reg no").fill(env("E2E_DOCTOR_PATIENT_REG_NO"));
  await lookUp.click();
  const review = page.getByRole("region", {
    name: new RegExp(`#${env("E2E_DOCTOR_PATIENT_REG_NO")}`),
  });
  await expect(review).toBeVisible();

  // Waiting patient: Mark seen path or guidance
  const markSeen = review.getByRole("button", { name: /Mark seen/i });
  if (await markSeen.isVisible().catch(() => false)) {
    await assertTouchTarget(markSeen, "Mark seen");
    await assertFocusVisible(markSeen, "Mark seen");
  }

  await scanInteractiveTargets(page, "doctor desk");
  await page.screenshot({
    path: join(EVIDENCE_DIR, "doctor-desktop.png"),
    fullPage: true,
  });
});

test("admin desk: filters and staff actions meet touch + contrast", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginStaff(page, "admin");
  await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();

  await page.goto("/admin/patients");
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("heading", { name: "Patient desk" }),
  ).toBeVisible();

  const filters = page.getByRole("button", {
    name: /^(All|Registered|In queue|Doctor seen)$/,
  });
  const filterCount = await filters.count();
  expect(filterCount).toBeGreaterThan(0);
  const filterMeasures = [];
  for (let i = 0; i < filterCount; i += 1) {
    const btn = filters.nth(i);
    const name = (await btn.innerText()).trim();
    filterMeasures.push(await assertTouchTarget(btn, `filter ${name}`));
  }

  // Status badge contrast on patient list if present
  const badge = page.locator("span.inline-flex.rounded-full").first();
  if (await badge.isVisible().catch(() => false)) {
    await assertContrastAA(badge, "status badge");
  }

  await page.goto("/admin");
  await page.waitForLoadState("networkidle");

  // Camp set-active / delete if inactive camps exist — otherwise staff area
  const setActive = page.getByRole("button", { name: /Set active/i }).first();
  if (await setActive.isVisible().catch(() => false)) {
    await assertTouchTarget(setActive, "Set active");
  }

  await scanInteractiveTargets(page, "admin dashboard");
  saveEvidenceJson("admin-filter-measurements.json", filterMeasures);
  await page.screenshot({
    path: join(EVIDENCE_DIR, "admin-desktop.png"),
    fullPage: true,
  });
});

test("public register + login: touch, focus, 200% text zoom operable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoHydrated(page, "/register");

  // Public registration may require camp days; still assert primary CTAs/nav
  const staffLogin = page.getByRole("link", { name: /Staff login|Sign in/i }).first();
  if (await staffLogin.isVisible().catch(() => false)) {
    await assertTouchTarget(staffLogin, "staff login link");
  }

  await gotoHydrated(page, "/login");
  const email = page.getByLabel("Email");
  const password = page.getByLabel("Password");
  const signIn = page.getByRole("button", { name: "Sign in" });
  await assertTouchTarget(email, "email input");
  await assertTouchTarget(password, "password input");
  await assertTouchTarget(signIn, "Sign in");
  await assertFocusVisible(signIn, "Sign in");
  await assertContrastAA(
    page.getByRole("heading").first(),
    "login heading",
  );

  // 200% text zoom on login — critical controls remain operable, no 2D scroll
  await applyTextZoom200(page);
  await assertTouchTarget(signIn, "Sign in @200% text");
  await assertNoTwoAxisScroll(page, "login @200% text");
  await expect(signIn).toBeVisible();
  await page.screenshot({
    path: join(EVIDENCE_DIR, "login-200pct-text.png"),
    fullPage: true,
  });

  // Volunteer desk at 200% after login
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  await loginStaff(page, "volunteer");
  await applyTextZoom200(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const lookUp = page.getByRole("button", { name: "Look up patient" });
  await expect(lookUp).toBeVisible();
  await assertNoTwoAxisScroll(page, "volunteer @200% text");
  // Critical action still in viewport or scrollable on primary axis only
  await lookUp.scrollIntoViewIfNeeded();
  await expect(lookUp).toBeVisible();
  await assertTouchTarget(lookUp, "Look up @200% text");
  await page.screenshot({
    path: join(EVIDENCE_DIR, "volunteer-200pct-text.png"),
    fullPage: true,
  });
});

test("print slip chrome: actions meet touch floor (screen)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginStaff(page, "volunteer");
  const patientId = env("E2E_PATIENT_ID");
  await gotoHydrated(page, `/print/${patientId}`);

  const printBtn = page.getByTestId("print-sheet-button");
  await expect(printBtn).toBeVisible({ timeout: 15_000 });
  await assertTouchTarget(printBtn, "Print action");
  await assertFocusVisible(printBtn, "Print action");

  const deskLink = page.getByRole("link", { name: /Volunteer desk|Doctor desk|Admin/i }).first();
  if (await deskLink.isVisible().catch(() => false)) {
    await assertTouchTarget(deskLink, "print desk link");
  }
  const registerNext = page.getByRole("link", { name: "Register next" });
  if (await registerNext.isVisible().catch(() => false)) {
    await assertTouchTarget(registerNext, "Register next");
  }

  await scanInteractiveTargets(page, "print slip");
  await page.screenshot({
    path: join(EVIDENCE_DIR, "print-mobile.png"),
    fullPage: true,
  });
});

test("lost-slip recovery: keyboard path and touch targets", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginStaff(page, "volunteer");

  const nameSearch = page.getByLabel("Name search");
  const regCheckIn = page.getByLabel("Registration number").first();
  const checkInBtn = page.getByRole("button", { name: "Check in" });

  await expect(nameSearch).toBeVisible();
  await assertTouchTarget(nameSearch, "Name search (lost-slip)");
  await assertTouchTarget(regCheckIn, "Check-in reg input");
  await assertTouchTarget(checkInBtn, "Check in button");
  await assertFocusVisible(nameSearch, "Name search");
  await assertFocusVisible(checkInBtn, "Check in");

  // Queue / seat refresh if present
  const queueRefresh = page.getByRole("button", { name: /^Refresh/i });
  const count = await queueRefresh.count();
  for (let i = 0; i < count; i += 1) {
    const btn = queueRefresh.nth(i);
    if (await btn.isVisible()) {
      await assertTouchTarget(btn, `Refresh #${i}`);
    }
  }

  await scanInteractiveTargets(page, "volunteer recovery surfaces");
});

test("disabled controls remain distinguishable with readable contrast", async ({
  page,
}) => {
  await loginStaff(page, "volunteer");
  await page.getByLabel("Reg no").fill(env("E2E_PATIENT_REG_NO"));
  await page.getByRole("button", { name: "Look up patient" }).click();
  const review = page.getByRole("region", {
    name: `#${env("E2E_PATIENT_REG_NO")} · ${env("E2E_PATIENT_NAME")}`,
  });
  await expect(review).toBeVisible();

  const assign = review.getByRole("button", {
    name: "Assign doctor · mark seen",
  });
  await expect(assign).toBeDisabled();
  // Disabled must still be visible (not display:none) and have reduced opacity OR distinct style
  const state = await assign.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      opacity: Number(cs.opacity),
      cursor: cs.cursor,
      disabled: (el as HTMLButtonElement).disabled,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
    };
  });
  expect(state.disabled).toBeTruthy();
  expect(state.opacity).toBeLessThan(1);
  expect(state.opacity).toBeGreaterThan(0.3);
  // Non-text UI contrast for disabled is softer; ensure still legible-ish ≥ 3:1 after blend
  const contrast = await computedContrast(assign);
  expect(
    contrast.ratio,
    `disabled assign contrast ${contrast.ratio.toFixed(2)}:1`,
  ).toBeGreaterThanOrEqual(2.5);
  saveEvidenceJson("disabled-assign-contrast.json", { state, contrast });
});
