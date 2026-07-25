/**
 * Wiring proofs for #25 — patient screens stay poll-only; staff opt into live.
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

test("patient-facing SeatBoard call sites never pass live", () => {
  const patient = read("src/app/patient/page.tsx");
  const register = read("src/app/register/page.tsx");
  const home = read("src/app/page.tsx");

  for (const [name, src] of [
    ["patient", patient],
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

test("SeatBoard live defaults false so patient poll path is unchanged", () => {
  const src = read("src/components/seat-board.tsx");
  assert.match(src, /live\s*=\s*false/);
  assert.match(src, /useFixedPoll/);
  assert.match(src, /useCampDeskRealtime/);
});

test("poll module is still used by staff and patient seat paths", () => {
  const poll = read("src/lib/poll.ts");
  assert.match(poll, /export const POLL_MS = 120_000/);
  assert.match(poll, /export function useFixedPoll/);
  // #25 must not remove the hook — #26 retires staff poll later
  assert.match(read("src/components/live-queue.tsx"), /useFixedPoll/);
  assert.match(read("src/components/seat-board.tsx"), /useFixedPoll/);
});
