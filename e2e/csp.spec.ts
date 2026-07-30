import { expect, test, type ConsoleMessage } from "@playwright/test";

/**
 * Live CSP served by middleware/proxy (#13 leftover + #39 relocation).
 * Asserts the response header, not next.config source greps.
 */
test("served CSP protects scripts and the production page hydrates cleanly", async ({
  page,
}) => {
  const cspViolations: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    const text = msg.text();
    if (
      msg.type() === "error" &&
      (/content security policy/i.test(text) ||
        /csp/i.test(text) ||
        /refused to execute/i.test(text) ||
        /refused to load/i.test(text))
    ) {
      cspViolations.push(text);
    }
  });

  const response = await page.goto("/");
  expect(response, "home page response").toBeTruthy();
  expect(response!.ok()).toBeTruthy();

  const csp = response!.headers()["content-security-policy"];
  expect(csp, "Content-Security-Policy header present").toBeTruthy();

  expect(csp).toMatch(/script-src[^;]*'nonce-[A-Za-z0-9+/=]+'/);
  // script-src must not allow arbitrary inline scripts.
  const scriptSrc = csp!
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("script-src"));
  expect(scriptSrc).toBeTruthy();
  expect(scriptSrc).not.toMatch(/'unsafe-inline'/);
  expect(scriptSrc).not.toMatch(/'strict-dynamic'/);

  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("heading", { name: "Medical Camp Desk" }),
  ).toBeVisible();

  const hasNextFlightRuntime = await page.evaluate(() =>
    Array.isArray(
      (window as Window & { __next_f?: unknown }).__next_f,
    ),
  );
  expect(hasNextFlightRuntime, "Next Flight runtime present").toBe(true);

  await page.route("**/auth/v1/token**", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: "invalid_grant",
        error_description: "Invalid login credentials",
      }),
    }),
  );
  await page.getByRole("link", { name: "Staff login" }).click();
  await page.getByLabel("Email").fill("hydration@example.com");
  await page.getByLabel("Password").fill("not-a-real-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Wrong email or password" }),
  ).toBeVisible();

  const unexpectedCspViolations = cspViolations.filter(
    (text) => !/executing inline script violates/i.test(text),
  );
  expect(
    unexpectedCspViolations,
    `Unexpected CSP console errors: ${unexpectedCspViolations.join(" | ")}`,
  ).toEqual([]);
});
