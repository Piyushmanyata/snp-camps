# #58 Evidence — Cancellation-safe QR sessions + continuous doctor resume

Date: 2026-07-26  
Worktree: local uncommitted (#56 + #57 + #58)

## Defects addressed

1. Native `detect()` only checked generation before await → stale resolve could fire lookup
2. Unmount/stop still risked React setState and double-attach across sessions
3. Doctor Mark seen stopped the camera; next patient required Open camera again
4. Terminal lookup retries could re-arm decode on the same QR indefinitely

## Fix summary

### Seams (no framework)

| Module | Role |
|---|---|
| `src/lib/qr-camera-session.ts` | Generation token, acquire/invalidate, track stop |
| `src/lib/qr-decode-orchestrator.ts` | Single in-flight detect, post-await live checks, pause/freeze/debounce |
| `src/lib/desk-ops.ts` | Unchanged desk result seam (lookup/assign) |
| `src/components/qr-scanner.tsx` | Wires camera + decode + desk; doctor keeps stream |

### Behaviours

- Stop/unmount: `invalidate()` + no setState when unmounted
- Pending detect after stop: orchestrator `isLive` false → zero callbacks
- Doctor camera lookup: pause decode, keep MediaStream; Mark seen → resume + debounce same QR (no second `getUserMedia`)
- Manual doctor path: still ready via reg field after success (#50)
- Terminal lookup failure: freeze auto-decode until Scan next / manual submit / new session
- Volunteer still stops stream on lookup (existing UX) with shared generation guards

## Verification

| Gate | Result |
|---|---|
| `tests/qr-scan-session.test.mjs` | 7/7 (deferred detect, stale acquire, race begin, pause, freeze, debounce, in-flight) |
| `npm run verify` | pass — lint (0 errors), **205** tests, build, JS budgets |
| `npm run test:db` | 32/32 (includes #57 lifecycle) |
| `npm run test:e2e` | **14/14** |

## Known gaps vs full #58 closing bar

- No Playwright fake-media two-patient/one-stream harness yet (ticket asks for it; unit session tests cover cancellation; e2e mark-seen remains manual-entry)
- Physical-device focus / a11y phone viewport not re-run this session
- #74 evidence validator not frozen

## Rollback

- Keep post-await generation guards if continuous-resume must roll back
- Fall back to explicit Open camera after Mark seen; never remove invalidate-after-await checks
