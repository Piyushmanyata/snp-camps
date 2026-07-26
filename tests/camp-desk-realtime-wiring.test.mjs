/**
 * Wiring proofs for #25/#26 — patient screens stay poll-only; staff live, no continuous poll.
 * Asserts on call sites, not on Realtime protocol behaviour (that is the pure module).
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

test("public/register SeatBoard call sites never pass live", () => {
  // Patient app portal was removed (#45); register + home remain poll-only.
  const register = read("src/app/register/page.tsx");
  const home = read("src/app/page.tsx");

  for (const [name, src] of [
    ["register", register],
    ["home", home],
  ]) {
    assert.match(src, /SeatBoard/, `${name} uses SeatBoard`);
    assert.doesNotMatch(
      src,
      /live(?:\s*=|\s*\})/,
      `${name} must not enable Realtime on SeatBoard`,
    );
  }
});

test("staff desks enable live seat board or live bridge", () => {
  const volunteer = read("src/app/volunteer/page.tsx");
  const admin = read("src/app/admin/page.tsx");
  const doctor = read("src/app/doctor/page.tsx");

  assert.match(volunteer, /live\b/);
  assert.match(admin, /live\b/);
  assert.match(doctor, /CampDeskLiveBridge/);
});

/** #50 — Doctor Station: one Mark seen control, no confirm dialog copy. */
test("#50 doctor station marks seen without confirm dialog copy", () => {
  const scanner = read("src/components/qr-scanner.tsx");
  const doctor = read("src/app/doctor/page.tsx");

  assert.match(scanner, /Mark seen/);
  assert.doesNotMatch(scanner, /Confirm patient · mark seen/);
  assert.match(scanner, /mode === "doctor"/);
  assert.match(scanner, /readyForNext/);
  assert.match(scanner, /#\$\{row\.reg_no\} marked seen/);
  assert.match(doctor, /mode="doctor"/);
  assert.match(doctor, /defaultOpen=\{false\}/);
});

test("SeatBoard live defaults false so patient poll path is unchanged", () => {
  const src = read("src/components/seat-board.tsx");
  assert.match(src, /live\s*=\s*false/);
  assert.match(src, /useFixedPoll/);
  assert.match(src, /useCampDeskRealtime/);
});

test("poll module still exists for patient + reconnect fallback", () => {
  const poll = read("src/lib/poll.ts");
  // #53: ~20s reconnect / non-live poll (Realtime remains primary on staff desks).
  assert.match(poll, /export const POLL_MS = 20_000/);
  assert.match(poll, /export function useFixedPoll/);
  assert.match(read("src/components/seat-board.tsx"), /useFixedPoll/);
  assert.match(read("src/components/live-queue.tsx"), /useFixedPoll/);
  assert.match(read("src/components/camp-desk-live-bridge.tsx"), /useFixedPoll/);
});

test("#53 staff queue/seat catch-up uses minimal desk-live endpoint", () => {
  const liveQueue = read("src/components/live-queue.tsx");
  const seatBoard = read("src/components/seat-board.tsx");
  assert.match(liveQueue, /fetchDeskLive/);
  assert.match(seatBoard, /fetchDeskLive/);
  // LiveQueue is staff-only and must not import next/navigation for full RSC refresh.
  assert.doesNotMatch(liveQueue, /next\/navigation/);
  assert.doesNotMatch(liveQueue, /useRouter/);
  assert.match(read("src/lib/camp-desk-realtime.ts"), /20 seconds/);
});

test("#26 staff continuous poll retired — poll only while reconnecting", () => {
  const liveQueue = read("src/components/live-queue.tsx");
  const seatBoard = read("src/components/seat-board.tsx");
  const bridge = read("src/components/camp-desk-live-bridge.tsx");

  // LiveQueue is staff-only: fixed poll gated on reconnecting only.
  assert.match(liveQueue, /useFixedPoll\([^;]+reconnecting/);
  assert.doesNotMatch(
    liveQueue,
    /pollMs\s*>\s*0/,
    "LiveQueue must not continuous-poll via pollMs",
  );

  // SeatBoard: when live, poll only on reconnect; patient path still uses pollMs.
  assert.match(seatBoard, /live\s*\?\s*reconnecting/);
  assert.match(seatBoard, /pollMs\s*>\s*0/);

  // Bridge already reconnect-only.
  assert.match(bridge, /useFixedPoll\(\s*refresh\s*,\s*POLL_MS\s*,\s*reconnecting\s*\)/);
});

test("#26 no staff copy instructs manual-only refresh on Realtime desks", () => {
  const volunteer = read("src/app/volunteer/page.tsx");
  const admin = read("src/app/admin/page.tsx");
  assert.doesNotMatch(volunteer, /refresh manually/i);
  assert.doesNotMatch(admin, /auto-refresh/i);
  // #47: volunteer-facing UI drops "FCFS" jargon; keep a live queue hint.
  assert.match(volunteer, /Line · live/);
  assert.match(admin, /FCFS · assign doctor · live/);
});

test("#26 no unstable_cache in src/", () => {
  function walk(dir) {
    /** @type {string[]} */
    const hits = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) hits.push(...walk(p));
      else if (/\.(ts|tsx|js|mjs)$/.test(ent.name)) {
        const text = fs.readFileSync(p, "utf8");
        if (text.includes("unstable_cache")) hits.push(p);
      }
    }
    return hits;
  }
  const hits = walk(path.join(root, "src"));
  assert.deepEqual(hits, [], `unstable_cache still present: ${hits.join(", ")}`);
});

test("#26 doctor list uses use cache + doctors-list tag", () => {
  const src = read("src/lib/metadata.ts");
  assert.match(src, /["']use cache["']/);
  assert.match(src, /cacheTag\(\s*["']doctors-list["']\s*\)/);
  assert.match(src, /cacheLife\(/);
  assert.doesNotMatch(src, /unstable_cache/);
});

test("#26 active camp snapshot uses use cache + tag", () => {
  const src = read("src/lib/camp.ts");
  assert.match(src, /["']use cache["']/);
  assert.match(src, /cacheTag\(\s*["']active-camp-snapshot["']\s*\)/);
  assert.match(src, /cacheLife\(/);
  assert.doesNotMatch(src, /unstable_cache/);
});
