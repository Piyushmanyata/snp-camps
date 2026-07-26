# Ticket #74 Closure Evidence Report

- **Overall Status**: **PASS**
- **Commit SHA**: `838b7b81558849b14474154da10546a9e544c88c`
- **Dirty State**: `false`
- **Timestamp (UTC)**: `2026-07-26T20:30:37.492Z`
- **Platform**: `win32 (x64)`
- **Node**: `v24.18.0` | **npm**: `11.16.0` | **Next**: `Next.js v16.2.11`

## Stage Execution Matrix

| Stage | Result | Exit Code | Duration | Counts | SHA256 (Truncated) | Log File |
|-------|--------|-----------|----------|--------|---------------------|----------|
| `lint` | **PASS** | `0` | 7946ms | pass=0, fail=0, skip=0 | `ce754c3210e4...` | [`logs/lint.log`](logs/lint.log) |
| `unit` | **PASS** | `0` | 23812ms | pass=394, fail=0, skip=0 | `c5dc5cbb4128...` | [`logs/unit.log`](logs/unit.log) |
| `type_build` | **PASS** | `0` | 13794ms | pass=0, fail=0, skip=0 | `17659fd7cdc3...` | [`logs/type_build.log`](logs/type_build.log) |
| `budgets` | **PASS** | `0` | 541ms | pass=0, fail=0, skip=0 | `78cf1642f360...` | [`logs/budgets.log`](logs/budgets.log) |
| `db` | **PASS** | `0` | 14380ms | pass=81, fail=0, skip=0 | `08d340e3ac96...` | [`logs/db.log`](logs/db.log) |
| `e2e` | **PASS** | `0` | 99213ms | pass=35, fail=0, skip=0 | `e5e7f5faf9cc...` | [`logs/e2e.log`](logs/e2e.log) |
| `accessibility` | **PASS** | `0` | 33582ms | pass=7, fail=0, skip=0 | `d2e9bf68e843...` | [`logs/accessibility.log`](logs/accessibility.log) |
| `migration` | **PASS** | `0` | 3974ms | pass=0, fail=0, skip=0 | `317bd4aff841...` | [`logs/migration.log`](logs/migration.log) |
| `env_security` | **PASS** | `0` | 430ms | pass=0, fail=0, skip=0 | `dc09c146e97f...` | [`logs/env_security.log`](logs/env_security.log) |

## Integrity & Verification
- Manifest SHA256: `49aeaf6d39e5d15844cd55ef69a92a3d6e5ede39b606122360d0726e1d599142`
- All secrets and PHI have been redacted using standard patterns.
- No log outputs rely on handwritten summaries or ellipses.
