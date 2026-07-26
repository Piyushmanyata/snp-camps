/**
 * Wiring proofs for #56 — polling-only desks; no Realtime patient channels.
 * Behavioural protocol coverage lives in camp-desk-live.test.mjs.
 * Source absence of Realtime tokens is allowed here as a security boundary
 * (file/import existence), not expression shape.
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

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walkFiles(full, out);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test("Realtime patient subscription modules are gone", () => {
  assert.equal(
    fs.existsSync(path.join(root, "src/lib/camp-desk-realtime.ts")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(root, "src/lib/use-camp-desk-realtime.ts")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(root, "src/components/reconnecting-indicator.tsx")),
    false,
  );
});

test("src has no postgres_changes or supabase channel subscribe for desks", () => {
  const hits = [];
  for (const file of walkFiles(path.join(root, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    if (
      text.includes("postgres_changes") ||
      text.includes("useCampDeskRealtime") ||
      text.includes("subscribeCampDeskRealtime")
    ) {
      hits.push(path.relative(root, file));
    }
  }
  assert.deepEqual(hits, [], `Realtime leftovers: ${hits.join(", ")}`);
});

test("public/register SeatBoard call sites never pass live", () => {
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
      `${name} must not enable staff desk live on SeatBoard`,
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

test("#50 doctor station marks seen without confirm dialog copy", () => {
  const scanner = read("src/components/qr-scanner.tsx");
  const doctor = read("src/app/doctor/page.tsx");
  // Patients-you-saw collapsible lives on the isolated section island (#63).
  const seenPanel = read("src/components/section-data.tsx");

  assert.match(scanner, /Mark seen/);
  assert.doesNotMatch(scanner, /Confirm patient · mark seen/);
  assert.match(scanner, /mode === "doctor"/);
  assert.match(scanner, /readyForNext/);
  assert.match(scanner, /#\$\{row\.reg_no\} marked seen/);
  assert.match(doctor, /mode="doctor"/);
  assert.match(doctor, /DoctorSeenPanel/);
  assert.match(seenPanel, /defaultOpen=\{false\}/);
});

test("#57 doctor registered review has no Mark seen; check-in instruction present", () => {
  const scanner = read("src/components/qr-scanner.tsx");
  const deskOps = read("src/lib/desk-ops.ts");
  assert.match(scanner, /Check the patient in at the desk first/);
  assert.match(scanner, /queue_status === "registered" && mode === "doctor"/);
  assert.match(scanner, /queue_status === "waiting" && mode === "doctor"/);
  assert.match(deskOps, /check_in_required/);
  assert.match(deskOps, /CHECK_IN_REQUIRED_COPY/);
});

test("#58 scanner uses camera session + decode orchestrator generation guards", () => {
  const scanner = read("src/components/qr-scanner.tsx");
  assert.match(scanner, /QrCameraSession/);
  assert.match(scanner, /QrDecodeOrchestrator/);
  assert.match(scanner, /pauseDecodeKeepStream/);
  assert.match(scanner, /resumeDecodeSameSession/);
  assert.match(scanner, /invalidate\(\)/);
  assert.doesNotMatch(scanner, /scannerGeneration/);
});

test("SeatBoard live defaults false; staff path uses shared desk owner", () => {
  const src = read("src/components/seat-board.tsx");
  assert.match(src, /live\s*=\s*false/);
  assert.match(src, /useCampDeskLive/);
  assert.match(src, /useFixedPoll/);
});

test("staff queue/seat use shared camp desk live owner", () => {
  const liveQueue = read("src/components/live-queue.tsx");
  const seatBoard = read("src/components/seat-board.tsx");
  assert.match(liveQueue, /useCampDeskLive/);
  assert.match(seatBoard, /useCampDeskLive/);
  assert.doesNotMatch(liveQueue, /next\/navigation/);
  assert.doesNotMatch(liveQueue, /useRouter/);
  assert.match(read("src/lib/poll.ts"), /POLL_MS = 20_000/);
});

test("#56 continuous ~20s poll is the staff freshness owner", () => {
  const owner = read("src/lib/camp-desk-live.ts");
  assert.match(owner, /POLL_MS/);
  assert.match(owner, /visibilitychange/);
  assert.match(owner, /subscribeCampDeskLive/);
  assert.doesNotMatch(owner, /postgres_changes/);
  assert.doesNotMatch(owner, /subscribeCampDeskRealtime/);
});

test("doctor bridge polls continuously without Realtime", () => {
  const bridge = read("src/components/camp-desk-live-bridge.tsx");
  assert.match(bridge, /useFixedPoll\(\s*refresh\s*,\s*POLL_MS\s*,\s*Boolean\(campId\)\s*\)/);
  assert.doesNotMatch(bridge, /useCampDeskRealtime/);
  assert.doesNotMatch(bridge, /reconnecting/);
});

test("#56 no staff copy instructs manual-only refresh on live desks", () => {
  const volunteer = read("src/app/volunteer/page.tsx");
  const admin = read("src/app/admin/page.tsx");
  // Queue titles live on the shared scan/queue island (#63).
  const scanQueue = read("src/components/desk-scan-queue.tsx");
  assert.doesNotMatch(volunteer, /refresh manually/i);
  assert.doesNotMatch(admin, /auto-refresh/i);
  assert.match(scanQueue, /Line · live/);
  assert.match(scanQueue, /FCFS · assign doctor · live/);
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
