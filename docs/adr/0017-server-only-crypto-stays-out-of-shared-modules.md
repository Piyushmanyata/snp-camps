# Server-only crypto stays out of shared modules

---
Status: accepted
---

`src/lib/staff-password.ts` held two unrelated things: pure password *policy*
(`isStaffPasswordStrong`, `MIN_PASSWORD_LENGTH`, the alphabets) and the password
*generator*, which draws from `node:crypto`'s `randomInt`.

The generator is server-only — one admin route mints staff passwords. The policy
is not: `change-password-card.tsx` validates the field in the browser, and
`sign-out.tsx` imports that card statically, so every staff page carries it.

ES module imports are all-or-nothing. Importing `isStaffPasswordStrong` pulled
the whole module, therefore `node:crypto`, therefore Turbopack's browserify
polyfill for it — `crypto-browserify`, `asn1.js`, `readable-stream`, `buffer` —
into the eager client bundle. Measured cost: **124.6 KB gzipped (418 KB raw) on
eight routes**: `/admin`, `/admin/clinical`, `/admin/clinical-operators`,
`/admin/patients`, `/clinical`, `/register`, `/team-lead`, `/volunteer`.
`/admin` initial JS was 412 KB gzipped; it is now 288 KB. Nothing on those pages
ever called the generator.

**A module reachable from a client component holds no Node built-in import.**
The generator moved to `src/lib/staff-password-generate.ts`, which opens with
`import "server-only"` so the boundary fails the build rather than regressing
quietly. It carries its own character-set constants, because they are generator
data and nothing else reads them. `staff-password.ts` is left holding only what
its client and server callers actually import: `MIN_PASSWORD_LENGTH`,
`DEFAULT_STAFF_PASSWORD_LENGTH`, and `isStaffPasswordStrong`.

Rejected: reimplementing `randomInt` on Web Crypto `getRandomValues` in the
shared module. It keeps one file instead of two, but replaces a vetted,
unbiased CSPRNG helper with hand-rolled rejection sampling on the path that
mints staff credentials. AGENTS.md §8 does not permit weakening security to
save a file.

No new test guards this. The per-route budgets in `js-route-budgets.json` were
ratcheted to the post-fix measurements by the repo's `min(old,
ceil(gzip*1.03/1000)*1000)` never-raise rule, so `npm run check:js-budget` fails
on a real production build if the polyfill returns — an empirical guard, not a
source-text regex.
