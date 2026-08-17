# ADR 0026 — The client address is trusted only on Vercel

Status: accepted (2026-08-17)

## Context

`checkRateLimit` and `checkDistributedRateLimit` bucket public requests by client
address. `clientAddress` derived that address by reading, in order,
`x-vercel-forwarded-for`, `x-forwarded-for`, `x-real-ip` and `cf-connecting-ip`,
falling back to the platform header first even when not running on Vercel.

Nothing strips those headers off Vercel. A caller could set any of them per
request and land in a fresh bucket every time, so the only throttle on the
unauthenticated `/api/self-registration` route could be walked past by rotating a
header. The durable limiter inherits the flaw, because
`checkDistributedRateLimit` HMACs the same `rateLimitIdentifiers` output.

## Decision

Trust exactly one header, and only where the platform writes it: on Vercel, read
`x-vercel-forwarded-for`. Anywhere else, the address is `"unknown"`.

## Rejected alternative

**A `TRUSTED_CLIENT_IP_HEADER` env var naming the header a reverse proxy writes.**
Implemented first, then reverted. It is configuration for a deployment target
that does not exist — this app deploys on Vercel (`vercel.json`, and `VERCEL_ENV`
is read nowhere else in the codebase). Its only live consumer was the test
runner, which made production code carry a knob whose sole value came from test
scaffolding. If a non-Vercel deployment ever ships, reintroduce it then, with a
proxy that actually overwrites the header.

## Consequences

- Off Vercel — local development and the test suite — every caller shares the
  single `"unknown"` bucket. Per-IP limiting is effectively off there, and the
  subject key (`keyType: "subject"` / `"both"`) carries the throttle instead.
  This is acceptable because no production traffic runs off Vercel.
- `tests/route-loader.mjs` sets `VERCEL_ENV` so the suite exercises the
  production branch, and so a single `node --test tests/x.test.mjs` behaves the
  same as `npm test`.
- A non-Vercel production deployment would ship with per-IP throttling disabled.
  That is a deliberate, documented gap, not an oversight — see the rejected
  alternative for how to close it.
