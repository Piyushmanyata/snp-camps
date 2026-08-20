/**
 * Field a11y locks for #30 — outdoor touch + contrast tokens + reduced motion.
 * Not a full WCAG suite; guards the non-negotiable desk decisions.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src/app/globals.css"), "utf8");
const ui = readFileSync(join(root, "src/components/ui.tsx"), "utf8");

function relL(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const f = (c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg, bg) {
  const L1 = relL(fg);
  const L2 = relL(bg);
  const [a, b] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (a + 0.05) / (b + 0.05);
}

function cssVar(name) {
  const re = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`);
  const m = css.match(re);
  assert.ok(m, `missing CSS var ${name}`);
  return m[1];
}

test("touch-min is 48px (3rem)", () => {
  assert.match(css, /--touch-min:\s*3rem/);
  assert.match(css, /\.jump-chip\s*\{[\s\S]*?min-height:\s*var\(--touch-min\)/);
  assert.match(css, /\.mobile-dock-item[\s\S]*?min-height:\s*var\(--touch-min\)/);
});

test("focus-visible ring and prefers-reduced-motion stay on", () => {
  assert.match(css, /:focus-visible\s*\{[\s\S]*?outline:\s*3px\s+solid/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /\.pressable:active:not\(:disabled\)\s*\{\s*transform:\s*none/);
});

test("toasts clear the dock and the sticky submit bar", () => {
  // The error toast persists until tapped. At bottom: 1rem it sat on top of
  // the dock and the register submit bar — the two controls the desk needs.
  assert.match(css, /\.app-toast\s*\{[^}]*position:\s*fixed/);
  const raised = [
    ...css.matchAll(
      /body:has\(\.mobile-dock\)\s*\.app-toast,\s*body:has\(\.sticky-submit\)\s*\.app-toast\s*\{([^}]*)\}/g,
    ),
  ].map((match) => match[1]);
  assert.ok(raised.length > 0, "no .app-toast dock offset rule");
  assert.ok(
    raised.some((body) => /bottom:\s*calc\(var\(--dock-height\)/.test(body)),
    "toast is not raised above the dock / sticky submit bar",
  );
});

test("skip link + field Input errors use alert role", () => {
  assert.match(css, /\.skip-link\s*\{/);
  assert.match(ui, /role="alert"/);
  assert.match(ui, /ErrorBox[\s\S]*?role="alert"/);
  // Field-level Input error span
  assert.match(
    ui,
    /error \? \(\s*<span[\s\S]*?role="alert"/,
  );
});

test("shared Button/Input targets are ≥48px (min-h-12 or 3.25rem)", () => {
  assert.match(ui, /min-h-12/);
  assert.match(ui, /min-h-\[3\.25rem\]/);
  assert.match(ui, /h-12 w-12/); // back control
});

/**
 * Supplemental source locks for #69 defect classes (not proof of render).
 * Browser proof lives in e2e/a11y-computed.spec.ts.
 */
test("#69 seat-board / freshness / admin controls declare ≥48px classes", () => {
  const seat = readFileSync(join(root, "src/components/seat-board.tsx"), "utf8");
  const fresh = readFileSync(
    join(root, "src/components/desk-freshness-indicator.tsx"),
    "utf8",
  );
  const patients = readFileSync(
    join(root, "src/components/admin-patients.tsx"),
    "utf8",
  );
  const staff = readFileSync(join(root, "src/components/admin-staff.tsx"), "utf8");
  const camps = readFileSync(join(root, "src/components/admin-camps.tsx"), "utf8");
  const scanner = readFileSync(
    join(root, "src/components/qr-scanner.tsx"),
    "utf8",
  );

  assert.match(seat, /min-h-12/);
  assert.doesNotMatch(seat, /min-h-8/);
  assert.match(fresh, /min-h-12/);
  assert.doesNotMatch(fresh, /min-h-10/);
  assert.match(patients, /min-h-12/);
  assert.doesNotMatch(patients, /min-h-9/);
  assert.match(staff, /min-h-12/);
  assert.doesNotMatch(staff, /min-h-11/);
  assert.match(camps, /min-h-12/);
  // Computed contrast defect class: no opacity-reduced brand ink on soft panels
  assert.doesNotMatch(scanner, /text-brand\/80/);
  assert.doesNotMatch(scanner, /text-amber-900\/80/);
});

test("palette pairs meet AA normal text (≥4.5:1) for body/labels", () => {
  const foreground = cssVar("--foreground");
  const background = cssVar("--background");
  const card = cssVar("--card");
  const muted = cssVar("--muted");
  const brand = cssVar("--brand");
  const brandSoft = cssVar("--brand-soft");
  const danger = cssVar("--danger");
  const dangerSoft = cssVar("--danger-soft");

  const pairs = [
    ["foreground/background", foreground, background],
    ["foreground/card", foreground, card],
    ["muted/background", muted, background],
    ["muted/card", muted, card],
    ["brand/card", brand, card],
    ["brand/background", brand, background],
    ["brand/brand-soft", brand, brandSoft],
    ["white/brand", "#ffffff", brand],
    ["danger/card", danger, card],
    ["danger/danger-soft", danger, dangerSoft],
    ["white/danger", "#ffffff", danger],
  ];

  for (const [label, fg, bg] of pairs) {
    const r = contrast(fg, bg);
    assert.ok(
      r >= 4.5,
      `${label} ${fg} on ${bg} = ${r.toFixed(2)}:1 (need ≥4.5)`,
    );
  }
});
