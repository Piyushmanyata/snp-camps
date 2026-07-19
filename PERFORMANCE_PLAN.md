# SNP Camps Performance Plan

## Project Completion Goal

Reduce public page latency and Supabase read load while preserving the existing
registration, queue, auth, and scan semantics. Complete only when the app has a
cached, single-round-trip public camp snapshot, request-level Supabase client
deduplication, green lint/tests/production build, and the idempotent database
change is applied to the configured Supabase project.

### In Scope

- Cache the safe public active-camp/seat snapshot for a short TTL.
- Replace the public home/register camp+seat waterfall with one RPC call.
- Deduplicate server Supabase clients and session-profile reads per request.
- Add only the supporting SQL/RPC and deployment-script lineage needed for the
  optimization.
- Apply the latest compatible React 19 patch; keep major TypeScript/ESLint type
  toolchains unchanged.
- Verify bundle analysis, correctness, database application, and git state.

### Out of Scope

- Changing patient data lifecycle, queue semantics, auth/RLS policy, or scan
  behavior.
- Adding a client state library, service worker, CDN, or new runtime.
- Load-testing an unknown remote URL or generating production traffic without a
  staging target.
- Broad visual redesign.

### Constraints

- Next.js 16.2.10, React 19, Supabase, Vercel.
- No secrets in output or commits.
- Follow the existing flat SQL lineage because the Supabase CLI is unavailable
  and the repository already uses `scripts/apply-*.mjs`.
- Single-agent/sequential execution; reserve at least 20% effort for review and
  verification.

## Acceptance Criteria

1. Anonymous home and registration pages obtain camp metadata and seat stats via
   one `active_camp_snapshot` RPC and a short-lived server cache.
2. Cached data contains only public camp/day availability fields and can be
   stale for at most 5 seconds; registration capacity remains enforced by the
   existing authoritative RPC.
3. Repeated server Supabase-client/session-profile calls in one request are
   memoized without changing cookie refresh behavior.
4. Existing behavior and security boundaries remain unchanged.
5. `npm run verify` and `npx next experimental-analyze --output` pass after the
   change.
6. The database SQL applies successfully to project `ruklmrzpyutvefancsgo` and
   is safe to re-run.
7. The final git diff contains only the planned files, is committed, and is
   pushed to `origin/main`.

## Skill Manifest

| Skill | Purpose | Phase |
|---|---|---|
| ponytail | Smallest safe diff; no speculative dependencies | all |
| lean-ctx | Compressed reads/search/build output and context ledger | all |
| graphify | Architecture and hot-path impact mapping | reconnaissance/review |
| vercel-react-best-practices | Remove waterfalls; server caching/deduplication | design/implementation |
| performance | TTFB, caching, bundle and runtime budget | design/verification |
| supabase | Safe server/client boundaries and schema rollout | database |
| supabase-postgres-best-practices | RPC/index/query design | database |
| nextjs-supabase-auth | Preserve cookie/session behavior | implementation/review |
| accessibility | Ensure performance changes do not regress semantics | review |
| code-review | Diff and regression review | final review |
| adversarial-review | Pre-mortem and hostile edge-case review | planning/final review |

## Phase and Batch Map

1. **Baseline and plan** — complete: clean git state, green verify, Graphify
   query, Next bundle analysis, current DB lineage inspected.
2. **Public read path** — add the snapshot SQL, server helper, and home/register
   integration. Verify type/lint/build.
3. **Request deduplication** — memoize server client and session profile. Verify
   auth-related routes still build and tests pass.
4. **Integrated verification and DB rollout** — run full checks, apply the
   idempotent SQL, re-check the function/indexes, refresh Graphify, review diff.
5. **Commit/push** — commit the bounded diff and push `main`; report evidence.

## Risks and Mitigations

- **Stale seat display:** TTL is 5 seconds; capacity enforcement stays in
  `register_patient`, so stale UI cannot overbook.
- **Service-role exposure:** the helper is imported only by server pages and
  returns a narrow public shape; it never reaches a client component.
- **Migration/code skew:** apply the SQL before publishing the code and verify
  the function shape before publishing the code.
- **Cache behavior on Vercel:** use Next's server data cache, not module-level
  mutable state; cache output is serializable and public-only.
- **Unrelated regressions:** keep queue/auth pages on their existing direct
  queries and run the full repository verification before push.

## Budget and Evidence

```yaml
mode: single-agent
max_incremental_tokens: 60000
max_high_capability_calls: 2
max_subagent_sessions: 0
max_skill_installs: 0
max_retry_cycles_per_batch: 2
reserve_percent_for_verification: 20
```

Evidence is recorded in the task response: baseline and final verify output,
bundle-analysis completion, SQL apply/query result, Graphify refresh summary,
git diff review, commit id, and push result.
