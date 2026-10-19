# Zaily Urpaq — Phased Implementation Roadmap

**Status:** Room foundation, anti-cheat episode behavior, result-export outbox and source-level LiveKit signaling/screen-share client are implemented. Database/LiveKit runtime, ICE, browser/device, load and installer verification remain. 2026-10-19.
**Approved spec:** `docs/superpowers/specs/2026-10-17-school-testing-platform-design.md`.
**Source:** Uploaded `school-crm.zip` (no `.git` metadata; excludes regenerated artifacts and secrets from the planning workspace).

## Why multiple plans

The approved specification covers several independently deployable subsystems. A single monolithic implementation cycle would obscure regressions and make migration/rollback unsafe. Every phase must pass its own tests and preserve backward compatibility until a deliberate cutover.

| Phase | Deliverable | Dependencies | Completion gate |
|---|---|---|---|
| 1 — Room foundation | Separate TestRoom, participant/session, snapshot, staff room APIs, migration and compatibility path | Existing NestJS/Prisma/PostgreSQL | Two rooms from one test, independent teacher ownership, safe duplicate names and reconnection, migration verified |
| 2 — Test lifecycle | Choice-only builder and Word import, frozen scoring, autosave, timer, retry, strict ranking, proctor event episodes, staff controls and audit | 1 | Correct results, idempotent finish, third violation preserves answers, browser reload/network exception tested |
| 3 — Reporting | Per-question/per-room analytics and automatic asynchronous idempotent export to separate PostgreSQL; CSV retained | 1–2 | Failed export never blocks tests; repeat export makes no duplicate; access-scoped analytics |
| 4 — Live monitoring | Scoped LiveKit JWT/token API, participant WebRTC publication, staff subscriptions, room grid/focus/strip, mobile fallback, network recovery | 1–2 | 30–40 visible students in a room; unauthorized cross-room access denied; manual share stop event; LAN media verified |
| 5 — Deployment, hardening | Redis-limits/presence, compose and LAN media reachability, Cloudflare web/API, launcher Windows 10/11, independent media health, load tests, installer | 1–4 | Production 8080 / dev 3100 / host 3000 untouched; 10 rooms / 300–400 synthetic clients test report; installer smoke |

## Explicit go/no-go checkpoints

- **Before any DDL:** backup actual school DB, prove restoration on a disposable DB, verify that `DATABASE_URL` points to the intended environment.
- **Before public API cutover:** preserve legacy endpoints until new UI operates against v2 room endpoints; never drop legacy rows during backfill.
- **Before LiveKit deployment:** verify TLS/HTTPS origin, consent, ICE/TCP/UDP reachability separately from Cloudflare web/API status; never claim Cloudflare Tunnel alone supplies media traversal.
- **Before installation:** all focused tests, full suite, migrations, production-compose smoke, Windows checks and load tests must pass in the target environment.

## Working method

TDD per behavior (RED → GREEN → regression), schema/db migration tests on disposable PostgreSQL, API authorization tests per actor, smoke tests from Windows. Changes stay in a working-copy or designated git branch; source upload does not contain `.git`, so no commit is claimed or attempted on the archive alone.

**First executable plan:** [`2026-10-18-room-foundation-implementation.md`](2026-10-18-room-foundation-implementation.md).

## Execution note — 2026-10-18

- Implemented the additive `TestRoom` / `RoomParticipant` schema and migration, staff-owned room APIs, six-digit codes, opaque SHA-256-hashed room sessions, lobby/start, immutable choice-only snapshot, per-attempt random order, autosave, server-side deadline sweep, automatic scoring and room leaderboard.
- Added `/room` for student name + room-code entry, per-room token persistence, waiting/start flow, timer, autosave, submit and result display. Existing school-code login and v1 routes remain available during transition.
- Verification completed after the current edits: Prisma schema validation; API build; web production build; `npm test`: 71 total, 69 passed, 2 PostgreSQL tests skipped.
- PostgreSQL tests are present but skipped because `TEST_DATABASE_URL` is unset and Docker Engine is unavailable. The actual migration/backfill has **not** yet been applied or integration-tested; do not call Phase 1 complete until it passes against a disposable PostgreSQL database and the Windows browser smoke checklist.
- No installer, Cloudflare public endpoint, LiveKit, separate reporting PostgreSQL, or load test was built in this phase.

## Execution note — 2026-10-19

- Added authenticated-by-room-session `POST /api/student/rooms/:roomId/v2/proctor-events` for hidden/restored events. Repeated hidden signals during one continuous episode count once; returning to the test allows the next episode to count.
- The third confirmed episode grades only the autosaved snapshot answers, keeps those answers, records `finishReason=PROCTORING_VIOLATION_LIMIT`, and leaves the result rankable. Audit log and staff room summaries expose warnings; the student UI reports the warning count and shows the normal result with the reason.
- Browser visibility and window-focus events are combined and deduplicated. Network failures are not sent as violations. A reload resumes with the room session token; closing a tab cannot be reliably distinguished from a reload by `beforeunload` alone, so it is not misclassified as a violation.
- Added an additive migration for `Submission.finishReason`, focused unit tests, static migration checks, and a PostgreSQL integration assertion for third-warning answer preservation.
- Phase 2 remains in progress: Word import exists elsewhere in the project but has not been verified end-to-end in the room builder; must still validate browser lifecycle, deadline/reload, full lifecycle idempotency, and a PostgreSQL migration/integration run before calling it complete.
- Added staff-scoped `GET /rooms/:roomId/analytics`: completed attempts only, average score/percentage, median completion time, per-question accuracy, wrong/unanswered counts, and ranked top 10. The staff tests screen now has a room selector and an accuracy bar chart; room access remains enforced by creator/admin scope.
- Phase 3 remains in progress: this is the room analytics slice. Automatic idempotent export into a separate PostgreSQL database is still not implemented; existing SQLite is a downloadable snapshot only.
- Applied the same preserve-and-grade third-warning rule to the legacy submission endpoints; legacy events now deduplicate hidden/pagehide signals by continuous episode and accept a return event. Text/manual answers remain in teacher review rather than being assigned a made-up score.
- Verification after these changes: API tests and Prisma validation pass; production web build passes. PostgreSQL integration cases remain skipped without `TEST_DATABASE_URL`; no production database was migrated.

## Execution note — 2026-10-19 (results export)

- Added the additive `ResultExportOutbox` migration and an atomic result snapshot enqueue when a v2/legacy attempt is completed or manually graded. The worker claims batches with `SKIP LOCKED`, applies a lease, writes by unique source attempt ID, and retries failures with capped exponential backoff.
- Added a separate `results-postgres` Compose service, `results_data` volume and init schema. Export failures do not run in the student request path. The existing SQLite download remains available.
- Updated Windows backup script to create dumps for both databases.
- Verification: `npx prisma validate`, API build/full suite (78 tests: 76 passed, 2 PostgreSQL tests skipped), Compose configuration validation and PowerShell parser check passed. Docker Engine was unavailable, so neither database container, actual migration nor end-to-end export was smoke-tested. Keep Phase 3 in progress until disposable PostgreSQL integration and delivery/retry are verified.
- Next: implement scoped LiveKit signaling/token flows and web client UI. Real screen capture support depends on each mobile OS/browser; the web API is not supported uniformly and requires HTTPS/user permission. A Cloudflare HTTP tunnel alone does not carry WebRTC media; verify public ICE/TURN routes before promising cross-network streaming.

## Execution note — 2026-10-19 (LiveKit source integration)

- Added short-lived HS256 room-scoped tokens without accepting room IDs/permissions from the client. Staff tokens are limited to their own running room and subscribe only; student tokens require the opaque room session plus an active attempt and can publish only `screen_share`. Student LiveKit names do not expose their real name to other participants; staff map participant identities to the authorized room roster.
- Added the browser share/stop control, teacher live room viewer, reconnect cleanup, HTTPS/browser capability messaging, LiveKit client dependency, optional Compose media profile, Caddy WebSocket proxy, and a focused token endpoint rate limit.
- Verification: full suite has 82 tests (80 passed, 2 PostgreSQL tests skipped); API build and web production build pass after upgrading Next.js to 16.4.2. Production Compose config passed validation with placeholder values including the optional media profile. Docker Desktop is not installed in the current development environment, so PostgreSQL migration/export delivery, LiveKit container startup, ICE reachability, browser/device capture and multi-student load are not verified. `npm audit` could not reach the npm registry in the sandbox; the Next.js upgrade install reported zero vulnerabilities, but a fresh online audit is still required.
- Mobile limitation: the app gracefully reports when screen capture is not supported or HTTPS is absent; web APIs cannot guarantee full-screen capture on every phone/browser. Verify school phones individually, and use a native companion app if iOS/browser policy blocks capture.
- Live media deployment requires a public HTTPS/WSS endpoint and a reachable host IP/ICE path; the Cloudflare HTTP tunnel only carries the web/signaling path, not UDP media. Do not enable the media profile or claim screen sharing is operational until school LAN/public ICE paths have been validated.
- Follow-up verification: the Prisma 6.19.3 CLI tree pinned vulnerable `deepmerge-ts@7.1.5`; added a root npm override to patched `deepmerge-ts@8.0.2` (Prisma's config code uses the unchanged plain-object `deepmerge` API). `npm audit --omit=dev` now reports zero vulnerabilities, Prisma schema validation passes, `npm test` passes 80/80 active tests with 2 PostgreSQL-only skips, and the Next.js 16.4.2 production build passes. The standalone web start command was corrected to launch on port 3100 by default; smoke requests to `/` and `/room` both returned HTTP 200. Docker Desktop is installed, but the Linux engine pipe remains unavailable; `wsl --status` returned `Wsl/E_ACCESSDENIED`, so PostgreSQL, Compose and real LiveKit/media checks remain blocked by the host environment.

## Execution note — 2026-10-19 (Compose and PostgreSQL integration)

- Built the production API and web images and started an isolated Compose project `zailyurpaq-qa-20261019` with disposable source/results volumes and host port 18080. The already-running school container/project was not changed.
- Both PostgreSQL services became healthy, API and web healthchecks passed, LiveKit 1.13.10 started, and Caddy routed `/`, `/room`, and `/api/health` successfully (all HTTP 200). The API applied all eight migrations to its isolated source database. Startup logs show the expected routes and no application startup error.
- Ran room and assignment PostgreSQL integration cases on a separate `schoolcrm_test` database: 2 tests passed, covering concurrent submit/grade safety, independent room sessions, redacted student snapshots, ownership, and the third proctor warning preserving answers.
- Added `apps/api/test/results-outbox-postgres.test.cjs`; ran it against a fresh source DB plus an isolated second PostgreSQL DB initialized from the results schema. Export delivered once, appeared in the sink with its score and payload, and a repeat did not create or redeliver a duplicate. Passed.
- Full local suite after adding the deployment regression checks: 85 tests, 82 passed, 0 failed, 3 PostgreSQL integration tests skipped by the ordinary runner because it has no test DB environment variables. All three database cases were run separately in the isolated Compose environment and passed. Prisma validation passed; fresh online `npm audit --omit=dev` returned zero vulnerabilities.
- Still not a go-live validation: no real browser/device screen capture, phone compatibility, LAN ICE/TCP/UDP path, Cloudflare tunnel/custom hostname, multi-room concurrency/load test, restore-from-backup exercise, or Windows 10/11 installer test has been completed. Compose QA sets LiveKit node IP to loopback by design, which cannot validate student devices on a separate host. Keep phases 4–5 and installer blocked on those deployment checks; do not claim all requested features fully production-ready.
- Fixed a deployment gap found during the launcher audit: Windows daily startup and fresh installation now request Compose's `media` profile. Fresh install generates independent LiveKit credentials and points it at the detected school LAN IPv4 address (loopback only if no LAN address is found). Added two deployment regression checks; both pass. The packaged installer has intentionally not been rebuilt yet.
- A lightweight QA check made 500 concurrent `/api/health` requests through Caddy with 0 errors (about 2.6 seconds overall, p50 63 ms, p95 440 ms). This checks the proxy/API path only and is not a substitute for the planned 300–400-client room workload or a school-device test.

## Execution note — 2026-10-19 (room load and Windows upgrade)

- A disposable production Compose stack exposed on `127.0.0.1:18081` reproduced a real concurrency failure: only 211/400 simultaneous room joins succeeded; the remainder returned HTTP 500 because Prisma's default interactive transaction wait expired after two seconds. The same default caused 85/400 concurrent submissions to fail after the join fix.
- Room join, autosave, submit, and proctor transactions now allow up to 20 seconds to acquire a connection and execute. A newly created participant's first submission uses attempt number one without a redundant count query; successful joins skip an unnecessary failed-code counter delete when none exists.
- The complete repeat on a clean disposable database passed: ten rooms with 40 students each, 400/400 joins (9.7 seconds), ten starts, 400/400 reads, 400/400 autosaves, 400/400 submissions (7.3 seconds), and correct room counts. This is synthetic local HTTP load; it does not validate school Wi-Fi, student phones, or LiveKit media.
- Existing Windows installations now receive missing LiveKit settings on startup without overwriting their existing database credentials or configured public media URL. Windows upgrade regression checks pass. The packaged installer remains unchanged pending physical device and media verification.
- After these changes, `npm test` passed 84 active tests with zero failures; three PostgreSQL-only tests were skipped by the ordinary runner and had already passed in the prior isolated database run. Both Windows media configuration regression cases passed.
- Follow-up: the separate results PostgreSQL reached 400/400 exports; primary DB had 400 graded submissions, 400 outbox entries, and 0 pending. Removed only `zaily-load-20261019` and its two QA volumes; verified `school-crm-postgres` remains healthy. This clears the temporary project noted above.
- Media configuration review found the installer advertised `ws://LAN:7881`, but 7881 is LiveKit's RTC TCP port, not its WebSocket signaling endpoint. Fresh installations now advertise `ws://LAN:8080/livekit` through Caddy, and the upgrade helper replaces the exact old generated `ws://IPv4:7881` form while preserving a custom `wss://` address. Three Windows helper tests pass. This fixes the signaling URL in source; remote phones still need a secure HTTPS/WSS origin and real browser/ICE verification.
- Final source test run after the signaling URL correction: 88 tests, 85 passed, 0 failed, 3 isolated-PostgreSQL cases skipped by the ordinary runner. PowerShell syntax parsing for the install, daily start and media upgrade scripts passed.
- The temporary QA Compose project and only its two test volumes were removed after the run. The pre-existing `school-crm-postgres` container remains healthy and untouched.
