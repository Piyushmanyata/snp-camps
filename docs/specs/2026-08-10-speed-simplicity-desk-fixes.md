# Speed, simplicity, and desk fixes

Status: Accepted · 2026-08-10 · Decisions grilled and confirmed with the owner.
Executor note: this spec is written to be executed literally. Every decision is
already made. Where a copy string is given, use it verbatim. Where a rule is
given, do not improvise beyond it. If something is genuinely impossible as
written, STOP and report — do not invent an alternative.

## Problem Statement

Field use of the camp app surfaced seven complaints, and a code audit confirmed
root causes for each:

1. **Raw JSON in clinical records.** `clinical-desk.tsx` renders prior-visit
   history as `JSON.stringify`; `admin-clinical-records.tsx` renders record
   data, corrections, and event/slip audits as three more raw `<pre>` JSON
   blocks. Operators cannot read these.
2. **Self-registration “not available”.** The route works and the live DB has
   an active camp with open seats — the real blocker is the Aadhaar camera
   scan, which is slow and unreliable on ₹6–10k fixed-focus phones. The dense
   Secure QR rarely resolves from a live video stream on that hardware.
3. **Prescription print screen broken on phones.** The A4 sheet uses fixed
   physical widths (62mm reg box + 92px QR) that cannot reflow; on a 375px
   phone it squishes and overflows.
4. **Slow everywhere.** Two dominant causes found: (a) `vercel.json` pins no
   region, so serverless functions run in the US default while Postgres sits in
   `ap-south-1` (Mumbai) — every page render pays multiple cross-continent
   round trips; (b) ~400KB+ gzipped eager JS on every working route
   (/volunteer 418K, /clinical 408K, /register 411K, /admin 419K).
5. **Too complex for the actual users.** Staff surfaces are English with
   jargon (“Exact patient lookup”, “Find unresolved follow-up”); the volunteer
   desk stacks team panels, KPIs, leaderboards and seat boards above the two
   actions that matter.
6. **Big black screen on the clinical desk.** `patient-qr-camera.tsx` always
   renders a black `aspect-video` box even before the camera starts. Clinical
   operators use a USB wedge scanner or type the reg number — the camera is
   dead weight.
7. **Errors render off-screen.** Failures show in `ErrorBox` blocks near the
   top of forms; after pressing Save at the bottom, the operator must scroll up
   to see what went wrong. Most never do.

Audit also found: the self-registration API returns `ok:false` with a
“registration succeeded” message when the status-token read fails (success
rendered as an error); the clinical desk maps DB errors through a brittle
nested-ternary regex chain; the “not available” medicine outcome needs a hidden
second tap; the desk register form collects an email nothing downstream uses;
and the public home page is English while every other patient surface is
Hinglish.

## Solution

Twelve owner-confirmed decisions plus audit fixes, all UI/client/server-component
work. **No database migrations. Do not create, edit, or delete anything under
`supabase/`.**

1. Pin Vercel functions to Mumbai (`bom1`).
2. App-wide toast system: sticky red error toasts at the bottom (dismiss on
   tap), green success toasts auto-dismissing after 3s; forms also scroll to
   and focus the first invalid field.
3. Clinical desk: camera removed entirely; one search input (USB wedge or
   typed number) with automatic current-camp → follow-up resolution; readable
   record rendering; progressive disclosure; Hinglish copy.
4. Admin clinical records: all three JSON dumps replaced with readable fields
   (layout otherwise unchanged, stays English).
5. Print page: A4 preview scales as one piece to fit phone width; two big
   buttons; Hinglish.
6. Volunteer desk: register + scan + queue first; KPIs/leaderboard/seat
   board/team panel collapsed behind one “Aur dekhein” section that
   lazy-loads its islands; Hinglish.
7. Register form: Hinglish, email field removed.
8. Aadhaar capture: photo path is already primary in the UI — add a native
   `BarcodeDetector` first-chance decode (photo and live), keep the WASM worker
   as fallback. Deep live-pipeline re-tune is OUT of scope (ADR 0012).
9. Home page: Hinglish, self-register stays the primary action.
10. Self-registration API: never report a successful registration as an error.
11. Eager-JS diet + budgets ratcheted down.
12. Admin screens: only the toast system and readable records — no language or
    layout changes.

## Implementation Decisions

Execute phases in order. One phase = one commit. After every phase run the
Phase gate (§Testing Decisions) before starting the next.

### Phase 1 — Vercel region pin

Edit `vercel.json` to:

```json
{
  "regions": ["bom1"],
  "crons": [
    {
      "path": "/api/cron/reminder-sms",
      "schedule": "30 2 * * *"
    }
  ]
}
```

No other change in this phase.

### Phase 2 — Toast system

**New file `src/lib/toast-bus.ts`** (framework-free):

```ts
export type ToastPayload = { tone: "error" | "success"; message: string };

let listener: ((toast: ToastPayload) => void) | null = null;

export function setToastListener(fn: ((toast: ToastPayload) => void) | null) {
  listener = fn;
}

export function showErrorToast(message: string) {
  listener?.({ tone: "error", message });
}

export function showSuccessToast(message: string) {
  listener?.({ tone: "success", message });
}
```

**New file `src/components/toast-host.tsx`** (`"use client"`). Behaviour:

- On mount, `setToastListener(setCurrent)`; on unmount, `setToastListener(null)`.
- Renders nothing when no toast. Renders ONE toast at a time; a new toast
  replaces the current one.
- Error tone: `role="alert"`, red (`bg-red-600 text-white`), stays until the
  user taps/clicks it (the whole toast is a button that dismisses). NO
  auto-dismiss timer.
- Success tone: `role="status"`, green (`bg-emerald-600 text-white`),
  auto-dismisses after 3000ms (clear the timer when the message changes — copy
  the remount-timer pattern from the existing `toast.tsx`).
- Fixed position: `position: fixed; left: 1rem; right: 1rem;
  bottom: calc(1rem + var(--safe-bottom)); z-index: 60; margin-inline: auto;
  max-width: 28rem;` — large text (`text-base font-semibold`), `min-h-12`,
  rounded-xl, shadow.
- Mount `<ToastHost />` once in `src/app/layout.tsx`, just before `</body>`’s
  closing wrapper (inside the body element, after `{children}`).

**Migration of existing toasts:** in `live-queue.tsx` and `qr-scanner.tsx`,
replace every `setToastMsg(x)` with `showSuccessToast(x)`, delete the
`toastMsg` state and the `<Toast …/>` JSX, then delete
`src/components/toast.tsx`. Keep the `.toast` CSS in `globals.css` only if the
new host reuses it; otherwise delete that block too.

**Error wiring rule (applies in later phases too):** wherever a user ACTION
(button press / submit) fails and the code calls `setError(message)` today, add
`showErrorToast(message)` alongside. Keep field-level inline errors (the
`error=` prop on `Input`) exactly as they are. The existing
scroll-to-first-invalid-field behaviour in `patient-form.tsx`
(`failValidation`) and `self-registration-flow.tsx` stays.

Remove the top-of-form `<ErrorBox message={error} />` ONLY in
`clinical-desk.tsx` (Phase 3) and `patient-form.tsx` (line ~1102, Phase 7),
where it sits far from the action buttons. Every other `ErrorBox` stays.

### Phase 3 — Clinical desk rework (`src/components/clinical-desk.tsx`)

1. **Delete the camera.** Remove the `PatientQrCamera` import and the
   `<PatientQrCamera …/>` JSX. Then delete the file
   `src/components/patient-qr-camera.tsx` (it has no other importer — verify
   with a search before deleting; if another importer exists, STOP and report).
2. **One search, wedge-friendly.** Wrap the lookup `Input` and the search
   button in a `<form onSubmit={(e) => { e.preventDefault(); void lookup(); }}>`
   so the USB wedge scanner’s trailing Enter submits automatically. One submit
   button: `Dhundein`. DELETE the “Find unresolved follow-up” button —
   `lookup()` already falls back to `lookupFollowup()` when the RPC reports
   `registration not found|not been seen`; keep that fallback. When BOTH lookups
   find nothing, show (toast + inline): `Yeh number kisi dekhe hue marij ka
   nahi mila. Number check karke dobara try karein.`
3. **Readable history.** Create `src/components/clinical-record-view.tsx` — a
   presentational component `ClinicalRecordView({ data })` that renders a
   transcription `data` object as labeled rows, skipping empty values:
   - Diagnosis: `normalizeDiagnoses(data.diagnoses, [])` → join options with
     `", "`; append `· Other: <other>` when present. (Import from
     `@/lib/clinical-diagnoses`; passing `[]` as the template treats every
     stored option as chosen, which is correct for read-only display.)
   - `Blood sugar`, `BP`, `Remarks`, `Medicines` — plain `label: value` rows.
   - Specs: one row `Specs: <type> · PD <pd>` plus one row per eye
     `RE sph/cyl/axis/vision/near` and `LE …` with the five values joined by
     ` / ` (skip an eye whose five values are all empty).
   - OT: `OT: <eye> · <procedure>` plus `Notes: <notes>` when present.
   - Any other primitive key: render `key: value` — never JSON.
   Use it at the history block (old line ~910) instead of the `<pre>`.
4. **Progressive disclosure.** Keep the current conditionals (correction input
   only when locked; slip replace only when a slip exists). Change the medicine
   “not available” two-tap: when the operator taps `Available nahi`, hide the
   outcome buttons for medicine and show the textarea (label: `Kaunsi dawaiyan
   available nahi thin?`) plus two buttons — `Save karein: dawai available
   nahi` (calls `resolve("medicine", "not_available")`) and `Cancel` (clears
   `medicineIntent` and shows the outcome buttons again).
5. **Error mapping.** Replace the nested ternary in `resolve()` with a
   `const RESOLVE_ERRORS: Array<[RegExp, string]>` table iterated with
   `find()`; same patterns, Hinglish messages. Every `setError(x)` in this file
   also fires `showErrorToast(x)`; every `setMessage(x)` success also fires
   `showSuccessToast(x)`. Remove the standalone `<ErrorBox message={error} />`.
6. **Hinglish copy (verbatim; keep admin-view banner English):**
   - Section title: `Marij dhundein`; input label: `Patient QR ya registration
     number`; placeholder: `USB scanner se scan karein ya number type karein`;
     button: `Dhundein`.
   - Invalid input: `Patient QR scan karein ya sahi registration number
     likhein.`
   - Locked banner: `Pehla record lock ho gaya hai. Neeche fields badlein aur
     reason ke saath correction jodein — purana record surakshit rehta hai.`;
     reason label: `Correction ka reason`.
   - Field labels: `Diagnosis` · `Anya diagnosis (optional)` · `Blood sugar
     (optional)` · `Blood pressure (optional)` · `Remarks / salaah` · `Parchi
     ki dawaiyan` · Specs card title `Chashme ka number (Specs)` · `Chashme ka
     type` · OT card `Operation (OT) detail` · `Aankh` · `Diagnosis /
     procedure` · `OT notes`.
   - Buttons: `Record save karein` · `Correction jodein`.
   - Outcome cards: headings `DAWAI` (medicine), `CHASHMA` (specs),
     `OPERATION (OT)` (ot); status line `Abhi tak: koi faisla nahi` when
     unresolved, else `Abhi tak: <outcome label>`. Outcome button labels:
     fulfilled → `De diya`, not_available → `Available nahi`, not_required →
     `Zaroorat nahi`, deferred → `Baad mein milega`. (RPC parameter values are
     UNCHANGED — only labels change.)
   - Save-first hint: `Pehle record save karein, phir faisla likhein.`
   - Slip buttons: `Slip dobara print karein` · `Slip badlein`; dialog title
     `Deferred slip badlein`, fields `Nayi date` / `Nayi jagah (venue)` /
     `Badalne ka reason`.
   - History: `Pichhle camps ka record · sirf padhne ke liye`; corrections:
     `Correction audit`; follow-up list: `Purane camp ke baaki kaam`; follow-up
     button: `De diya — pura karein`.
   - Success messages: `Record save ho gaya.` · `Correction jud gaya; purana
     record surakshit hai.` · `<HEADING> ka faisla save ho gaya.` · `Item pura
     ho gaya; purana record surakshit hai.` · `Nayi slip ban gayi.`; blocked
     popup suffix: `Slip window browser ne rok di — \"Slip kholein\" link
     dabayen.`; slip link text: `Slip kholein`.

### Phase 4 — Admin clinical records (`src/components/admin-clinical-records.tsx`)

Stays English. Replace the three `<pre>{JSON.stringify(…)}</pre>` blocks:

1. `record.data` → `<ClinicalRecordView data={record.data} />`.
2. `record.corrections` → a list: one line per correction — timestamp
   (`toLocaleString("en-IN")`) + reason + author name if the object carries one.
3. `{ events, slips }` → two short lists: each event as `event · timestamp`,
   each slip as `date · venue · timestamp`, appending ` · cancelled` when the
   slip object shows a cancelled/superseded marker.

Before coding 2–3, read the row shapes from the RPC that feeds this component
(defined in `supabase/migrations/20260809120000_clinical_export_and_diagnoses.sql`
and `20260809140000_clinical_export_review_fixes.sql` — READ ONLY, do not edit
migrations) and render the keys that exist. Unknown extra keys: render
`key: value` for primitives, skip objects. Raw JSON must not appear anywhere.

### Phase 5 — Print page for phones

**New file `src/components/scale-to-fit.tsx`** (`"use client"`):
a wrapper that renders `<div ref={outer} style={{height}}><div ref={inner}
style={{width: 794, transformOrigin: "top left", transform: scale(s)}}>{children}
</div></div>`. Compute `s = min(1, outerWidth / 794)` in a `useEffect` with a
`ResizeObserver` on the outer div, and set the outer height to
`inner.offsetHeight * s` so the page doesn’t leave a giant gap. Add className
`print-scale-wrap` on the outer div. In `src/app/print/print.css` add, inside
the existing `@media print` block:

```css
.print-scale-wrap,
.print-scale-wrap > div {
  transform: none !important;
  width: auto !important;
  height: auto !important;
}
```

In `src/app/print/[id]/page.tsx`, wrap `<PrescriptionSheet …/>` in
`<ScaleToFit>`. The sheet keeps `data-testid="prescription-sheet"` and all
print CSS — the printed output must be pixel-identical (the print e2e asserts
this; it must pass unchanged).

**Simplify `print-actions.tsx`:** keep exactly two controls — primary
`Print karein` (reprint state: `Dobara print karein (1 page)`; seen state:
`Puri ho chuki parchi print karein`) and secondary `Desk par wapas` (existing
deskHref). DELETE the `Register next` link. Status copy: heading states →
`Print ke liye taiyaar · line mein aa jayega` / `Dobara print · pehle se line
mein` / `Print · dekha hua marij`; success → `Marij line mein hai. Print
dialog khul gaya hai.`; failure → `Print taiyaar nahi ho paya. Dobara try
karein.` (also `showErrorToast`). Page footer note → `Parchi · clinical fields
haath se likhe jaate hain · QR sirf staff scan ke liye`.

### Phase 6 — Volunteer desk (`src/app/volunteer/page.tsx`)

Non-admin branch only (the admin branch renders staff management — leave it).
New order inside the Shell:

1. Register action: `ActionCard` — title `Naya marij register karein`,
   description `Naam, phone, Aadhaar — phir parchi print` (disabled copy:
   `Koi active camp nahi. Admin se camp chalu karwayein.`).
2. `DeskScanQueue` (scan + queue) — section titles become: scan card `Marij
   scan karein` with hint `QR scan karein, ya number/naam likhein`; queue card
   `Line (queue)` with hint `Pehle aao, pehle pao · live`.
3. One collapsed section at the bottom titled `Aur dekhein — points, seats,
   team`, built with the `OpenOnToggle` pattern from
   `src/components/admin-optional-lazy.tsx`: move `OpenOnToggle` into
   `src/components/ui.tsx` (export it) and reuse it. Inside, lazy-load (à la
   `dynamic(…, { ssr: false })`, only when opened): `TeamLeadPanel`,
   `VolunteerKpisSection` block (the Active-camp KPI card), and `SeatBoard`.
   Server-side: STOP fetching leaderboard/KPI/seat data eagerly for the
   non-admin branch — those loads (`loadSeatsSection`,
   `loadVolunteerKpisSection`, `loadStaffLeaderboardSection`) move behind the
   collapse: the lazy island fetches its own data on open via the existing
   `/api/desk/section` route used by `section-data.tsx` (follow the pattern
   already in `VolunteerKpisSection`). `loadQueueSection` stays eager — the
   queue is primary.
4. The `dock` prop stays. The active-camp name stays visible in a slim Card
   above the register action (name + venue only, no KPI grid).

A Team Lead’s roster read stays as-is (it renders inside `TeamLeadPanel`,
which now loads on open — pass the same props through the lazy wrapper).

### Phase 7 — Register form (`src/components/patient-form.tsx`)

1. **Delete the email field**: the `email` state, its `Input`, and pass
   `email: null` where `validated.values.email` was sent (both API payload
   sites). Do not touch `src/lib/patient-form-validate.ts` beyond making the
   email rule tolerate the always-empty value (if it already allows empty,
   leave it).
2. **Toast wiring** per Phase 2 rule; remove the standalone
   `<ErrorBox message={error} />` (~line 1102). `failValidation` already
   focuses the invalid field — keep that, and add `showErrorToast(message)`
   inside it.
3. **Hinglish copy (verbatim):** banner `Desk · sirf naam aur umar zaroori
   hai`; phone label `Ghar ka mobile number *` hint `Sirf contact ke liye —
   ghar ke log same number de sakte hain.`; phone gate `Pehle sahi mobile
   number daalein, tab Aadhaar scanner khulega.`; Aadhaar box heading `Aadhaar
   se form bharein` sub `Aadhaar card ka QR scan karein — details apne aap
   bhar jaayengi. Sirf mobile number type karna hai.`; scanned banner `Aadhaar
   scan ho gaya — details bhar gayi aur lock ho gayi.`; incomplete-scan banner
   `Aadhaar scan poora nahi hua. Dobara scan karein. 3 baar fail ho to Team
   Lead se kahein.`; legacy warning `Purana Aadhaar QR — details bina digital
   verify ke aayi hain. Card se milaan karein.`; attempts line `Fail scan:
   {n}/3`; manual button `Team Lead manual entry (audit hoti hai)`; volunteer
   note `Team Lead ko bulayein — volunteer manual entry nahi kar sakte.`
4. Remaining user-visible English strings in this file (identity labels,
   duplicate warnings, submit buttons, flash messages): translate to the same
   simple Roman-Hindi register, keeping these technical words untranslated:
   Print, QR, Aadhaar, Team Lead, Camp, Register, Scan, Slip. Submit buttons:
   `Register + Print` and `Sirf register`. If a string’s meaning is unclear,
   KEEP THE ENGLISH — never guess.

The same rule (translate visible strings, keep `data-testid`/ARIA semantics,
keep unclear strings English) applies to `qr-scanner.tsx` and
`live-queue.tsx` in this phase. Key strings: camera open `Camera kholein`,
stop `Camera band karein`, manual label `Registration number ya naam`, search
`Dhundein`, review actions `Parchi print karein` / `Dekha hua karein`, undo
`Wapas line mein`, toasts `#N dekha hua ho gaya` / `#N pehle se dekha hua tha`
/ `Wapas line mein aa gaya`.

### Phase 8 — Native detector fast path for Aadhaar

Files: `src/components/use-aadhaar-scanner.ts` only. No worker changes, no
changes to `qr-decode-geometry.ts` (its cap is protected by
`tests/qr-decode-surface.test.mjs` and has regressed twice — hands off).

1. At session start (`start()` and the beginning of `readPhoto()`), probe once:
   `const native = await canUseNativeQrDetector()` (import from
   `@/lib/qr-detector`) and construct a single
   `new (getBarcodeDetectorConstructor()!)({ formats: ["qr_code"] })` guarded
   by try/catch → `null`.
2. In the live loop, after `probeImage(probe)` produces the canvas, and in
   `readPhoto` after each probe draw: if the detector exists, `try { const hits
   = await detector.detect(canvas); const raw = hits[0]?.rawValue; if (raw) {
   const outcome = await client.decodePayload(raw); …handleOutcome as usual… }
   } catch { disable the detector for the rest of the session }` — and only
   when the native attempt produced nothing, fall through to the existing
   `client.decodeFrame(image, thorough)` call. Generation-token guards around
   every await, exactly like the surrounding code.
3. In `readPhoto`, ALSO try the native detector once on the full-resolution
   bitmap (drawn to a temp canvas at natural size) BEFORE the probe loop —
   ML Kit handles dense QRs at full resolution well.
4. `AadhaarCapture` is already photo-first; single copy change — desk photo
   button label from `Take full-resolution photo` to `Photo khinch kar scan
   karein`, patient label stays `Aadhaar ka photo lein`.

### Phase 9 — Home page Hinglish (`src/app/page.tsx`)

Verbatim copy: hero sub-line `Aankhon ka camp — seats limited hain. Online
khud register karein, desk par parchi milegi.`; self-register card title `Khud
register karein` description `Aadhaar card se · desk par line nahi` (disabled:
`Abhi koi camp nahi` / `Sab din full hain — baad mein dekhein`); staff card
description `Admin · team lead · volunteer`; steps → (`Khud registration`,
`Aadhaar scan karein · reg number milega`), (`Print se line mein`, `Desk
parchi print karega · pehle aao pehle pao`), (`Doctor se milna`, `Staff QR
scan karke seen karega`); footer `Naye staff? Admin se account banwayein.
Marij: Aadhaar card se khud register karein — login nahi chahiye.`; no-camp
card `Abhi koi active camp nahi. Baad mein dekhein, ya staff se poochein.`
Headings `Medical Camp Desk`, `Active camp`, `Seats`, `How it works` →
`Kaise hota hai` — everything else unchanged.

### Phase 10 — Self-registration API truth fix

In `src/app/api/self-registration/route.ts`, the post-RPC branch where the
`status_token` read fails currently returns
`errorResponse("Registration ho gaya…", 200)` — an `ok:false` body for a
successful registration. Replace with:

```ts
return NextResponse.json({
  ok: true,
  patientId: row.id,
  registrationNumber: row.reg_no,
  campDayId: row.camp_day_id,
  dayDate: row.day_date,
  queueStatus: "registered",
  statusUrl: null,
});
```

Then in `self-registration-flow.tsx` + `self-registration-receipt.tsx`, treat
`statusUrl: null` as “registered, no link”: the receipt renders without the
status-link block and shows `Status link desk par milega.` in its place. Type
changes follow (`statusUrl: string | null`).

### Phase 11 — JS budget ratchet

After Phases 1–10: `npm run build && npm run check:js-budget`. For every route
whose measured eager gzip DROPPED below its budget in `js-route-budgets.json`,
lower that budget to `ceil(gzip * 1.03 / 1000) * 1000` (the file’s own ratchet
formula). `/volunteer`, `/clinical`, and `/register` MUST come out lower than
their current budgets (418000 / 408000 / 411000) — if any did not drop,
investigate which phase failed to move its island behind a lazy boundary
before touching the budget file. NEVER raise any budget.

### Not changed

- No SQL, RLS, RPC, or migration changes; `supabase/` is read-only.
- The live Aadhaar decode pipeline’s probe geometry, escalation schedule, and
  `MAX_DECODE_EDGE` cap (ADR 0012 defers the deep re-tune).
- Print output: the A4 sheet’s printed geometry, `@page` rules, letterhead.
- Patient lookup page (`/lookup`) stays deliberately unlinked.
- Queue-state machine, idempotency, rate limits, CSP, auth predicates.
- Admin layouts and admin-facing English copy (except the three JSON blocks).
- `docs/` conventions; CONTEXT.md and ADR 0012 were already updated with this
  spec’s decisions.

## Testing Decisions

**Phase gate (run after every phase):** `npm run lint && npx tsc --noEmit &&
npm test && npm run build`. Fix failures before the next phase. When a unit
test fails ONLY because it asserts an English string this spec renames, update
the assertion to the new verbatim string — never weaken a logic assertion, and
never delete a test to make a phase pass.

**Final gate:** `npm run verify` (includes DB tests, e2e, JS budgets, env
check). DB tests require the local Supabase stack (`npx supabase start`);
note: these tests skip themselves with a “Postgres unavailable” message when
the stack is down — a skipped DB suite is NOT a pass; run them for real.

**Known test touch-points:**

- `e2e/island-split.spec.ts` — will need its expected island lists updated for
  Phase 6’s lazy moves and Phase 3’s camera deletion.
- `e2e/print-prescription.spec.ts` — must pass UNCHANGED in print behaviour;
  if the preview wrapper breaks a selector, fix the wrapper, not the print
  assertions.
- `e2e/register-print.spec.ts`, `e2e/a11y-computed.spec.ts`,
  `e2e/desk-action-timing.spec.ts` — update renamed strings only.
- `tests/qr-decode-surface.test.mjs` — must pass untouched (Phase 8 guard).
- New unit tests required: `tests/toast-bus.test.mjs` (listener set/unset,
  error vs success payloads) and `tests/clinical-record-view.test.mjs`
  (renders new-shape `{options, other}` and legacy flat-array diagnoses; no
  “[object Object]”, no raw JSON in output). Follow existing test style
  (node:test + route-loader stubs as in `tests/`).

## Out of Scope

- Deep live-scanner pipeline re-tune against the fake-camera empirical harness
  (own follow-up; ADR 0012).
- Devanagari script UI; admin-surface Hinglish.
- Any schema/RPC change (e.g. folding the status-token read into the
  registration RPC) — candidates for a later DB-touching spec.
- Linking `/lookup`, SMS changes, template editor changes.
- Wizard-style clinical entry.

## Further Notes

### Defects this change is expected to fix

1. Black dead camera box on the clinical desk (component deleted).
2. Raw JSON shown to operators/admins in four places.
3. Self-registration success reported as an error when the token read fails.
4. Errors invisible at the bottom of long forms (sticky bottom toasts).
5. A4 print preview unusable on phones (scaled preview).
6. Cross-continent DB latency on every request (region pin).
7. Medicine “not available” hidden second tap (explicit confirm flow).

### Documentation updated with this spec (already done — do not redo)

- `CONTEXT.md`: Patient QR (clinical desk has no camera), Clinical follow-up
  mode (single search, automatic fallback).
- `docs/adr/0012-photo-first-aadhaar-capture.md`.

### Execution guidance

- Phases are ordered by risk and dependency; do not reorder. Phases 1, 9, 10
  are tiny and safe; Phase 3 and 6 are the largest.
- One commit per phase, message `spec 2026-08-10 phase N: <title>`.
- Copy strings are law. If a Hinglish string given here conflicts with an
  existing test’s expectation, the spec string wins and the test updates.
- If any instruction cannot be executed as written (missing symbol, moved
  file), STOP that phase and report the discrepancy instead of improvising.
- Do not add dependencies. Do not modify `package.json` except nothing — no
  script or dependency changes are needed by this spec.
- Never edit `supabase/**`, `js-route-budgets.json` (except Phase 11 lowering),
  `qr-decode-geometry.ts`, or `aadhaar-decode.worker.ts`.
