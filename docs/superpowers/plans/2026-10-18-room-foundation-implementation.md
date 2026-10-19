# Independent Test Rooms and Student Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn each reusable `Assignment` into a template that can run in multiple independent rooms with 6-digit codes, immutable launch snapshots, teacher-owned room controls, and room-specific student sessions that permit duplicate names safely.

**Architecture:** Add `TestRoom` and `RoomParticipant` as PostgreSQL/Prisma entities while keeping the legacy assignment/room fields temporarily for an additive migration. Implement `RoomsService` as the room lifecycle boundary and `RoomSessionGuard` for opaque session-token authorization; a thin controller exposes v2 endpoints without breaking existing v1 endpoints. Snapshot test questions once at room start; do not publish answer keys to students.

**Tech Stack:** Existing NestJS 11, TypeScript, Prisma 6.19, PostgreSQL 17, Node native `node:test`, Next.js 15/React 19. No new UI framework; reuse existing API and web client utilities.

**Spec:** `docs/superpowers/specs/2026-10-17-school-testing-platform-design.md` (approved 2026-10-17). Roadmap: `docs/superpowers/plans/2026-10-18-school-platform-roadmap.md`.

## Global Constraints

- Active room code: exactly six decimal digits; 10 active rooms, 30–40 participants each; teacher accesses only own assignment rooms; admin accesses all.
- One test can run in multiple independent rooms; no new distinct name may join after start; 'Start now' works before lobby target; no pause.
- Same room name may occur multiple times; session tokens are 32-byte cryptographically random and stored only as SHA-256 hashes in DB.
- Reload/reconnect with valid token resumes an existing unfinished attempt; no token must never grant another participant's answers. A pre-registered name may start a separate `TOKENLESS_REENTRY` after start per approved spec, but gets no prior attempt's data; distinct name is denied.
- Clock and frozen question snapshot derive from PostgreSQL server time; do not alter running rooms after start.
- Avoid host port 3000 (web dev 3100; installed HTTP 8080); Windows 10/11 deployment phase later.
- Additive DB migrations only, preserve pre-existing assignments/submissions/answers; keep old routes functional until UI cutover.
- No plaintext tokens, answer keys, or room codes in audit/security logs. Do not read, print, ship or commit `.env`.
- A task is not complete until focused tests pass and `npm test` reports all results (or clearly documents test infrastructure as unavailable).
- Source ZIP contains no `.git`; commit only when a real source-controlled working tree is supplied; otherwise attach a patch/changed-source archive, never invent a git commit.

## Review Focus

1. **Two students with the same normalized name:** joining independently must yield different participant/attempt IDs, and neither token may read the other's answers (Task 3).
2. **Concurrent joins into a nearly-full lobby:** the last place cannot be double-allocated, and code uniqueness cannot race (Tasks 2 and 4).
3. **Old rows during migration:** historical questions/submissions/answers must remain intact and attributable after backfill; rollback is non-destructive (Task 1).
4. **Teacher attempts cross-room control:** staff-only routes must reject access to rooms created by another teacher even if the room ID is known (Tasks 2 and 4).
5. **Tokenless entry after room start:** known pre-start name creates an isolated new attempt with a security audit event; unknown name gets HTTP 409; no old answers leak (Task 3).

---

## File Map / Contract

| Responsibility | Location |
|---|---|
| Tables, relations, indexes | `prisma/schema.prisma` |
| Expand/backfill migration | `prisma/migrations/20261018110000_independent_test_rooms/migration.sql` |
| Typed request/response validation | `apps/api/src/assignments/rooms.dto.ts` |
| Room lifecycle and snapshots | `apps/api/src/assignments/rooms.service.ts` |
| Room endpoints | `apps/api/src/assignments/rooms.controller.ts` |
| Student session resolution | `apps/api/src/assignments/room-session.guard.ts` |
| Service registration | `apps/api/src/assignments/assignments.module.ts` |
| Existing logic to adapt at cutover | `apps/api/src/assignments/assignments.service.ts` |
| Web client API helpers and room flow | `apps/web/app/client-utils.ts`, `apps/web/app/page.tsx` |
| Focused domain tests | `apps/api/test/rooms-foundation.test.cjs` |
| DB integration/migration tests | `apps/api/test/rooms-postgres.test.cjs` |
| Web API flow tests | `apps/web/test/client-utils.test.mjs` |

### Stable v2 interfaces

- `RoomsService.createRoom(assignmentId: string, input: CreateRoomDto, actor: AuthenticatedUser): Promise<RoomSummary>`
- `RoomsService.listRooms(actor: AuthenticatedUser, assignmentId?: string): Promise<RoomSummary[]>`
- `RoomsService.getRoom(roomId: string, actor: AuthenticatedUser): Promise<RoomDetail>`
- `RoomsService.joinRoom(code: string, firstName: string, lastName: string, sessionToken?: string, sourceIp?: string): Promise<RoomJoinResult>`
- `RoomsService.getStudentRoom(roomId: string, token: string): Promise<StudentRoomView>`
- `RoomsService.startRoom(roomId: string, actor: AuthenticatedUser): Promise<RoomDetail>`
- `RoomSessionGuard.canActivate(context: ExecutionContext): Promise<boolean>`; reads `Authorization: Bearer <opaque-room-token>` on student-only v2 endpoints, validates SHA-256 against participant record and room scope. Staff JWT remains separate.
- `CreateRoomDto = { lobbyTarget: number; durationMinutes?: number }`; validate `1 <= lobbyTarget <= 40` and `1 <= durationMinutes <= 600` when supplied. New v2 endpoint does not create an Assignment.
- `RoomSummary = { id, assignmentId, joinCode, status, lobbyTarget, count, startedAt, durationMinutes }` (staff-only; never reveal joinCode in public enumeration).
- `RoomJoinResult = { participantId, attemptId, roomId, sessionToken?, status: 'LOBBY'|'RUNNING', resumed: boolean }`; `sessionToken` is returned only on a fresh join and must not be logged.
- `StudentRoomView` omits `isCorrect`, `config`, `snapshot.correctOptions`, and all answer keys.
- HTTP routes: `POST /api/assignments/:assignmentId/rooms`, `GET /api/assignments/:assignmentId/rooms`, `GET /api/rooms/:roomId`, `POST /api/rooms/:roomId/start` (staff JWT); `POST /api/student/rooms/join-v2` (public with student name+room code and optional prior token), `GET /api/student/rooms/:roomId/v2` (RoomSessionGuard). All v1 routes remain accessible during transition.

### DB design fixed for implementation

- `TestRoom`: `id String @id @default(cuid())`; `assignmentId`, `creatorId`, `joinCode String @unique @db.VarChar(6)`, `status RoomStatus @default(LOBBY)`, `lobbyTarget Int`, `durationMinutes Int?`, `startedAt DateTime?`, `finishedAt DateTime?`, `snapshot Json?`, `createdAt DateTime @default(now())`, `updatedAt DateTime @updatedAt`; relations to `Assignment`, `User`, `RoomParticipant`, `Submission`; indexes `(assignmentId,status)`, `(creatorId,status)`.
- `RoomStatus`: `LOBBY | RUNNING | FINISHED | CANCELLED`.
- `RoomParticipant`: `id String @id @default(cuid())`, `roomId`, `firstName`, `lastName`, `sessionHash String @unique @db.Char(64)`, `joinedAt`, `lastSeenAt`; unique participant identity is `id`, NOT normalized name; relation to submissions; `(roomId,joinedAt)` index.
- Add nullable `roomId`, `participantId` to `Submission` initially; only new v2 attempts require both; maintain old `assignmentId` field until all readers migrate. Use `Submission.attemptNo` per participant. Add `RoomReentryAudit` or existing `AuditLog` action `TOKENLESS_REENTRY`; audit actor is not fabricated when student has no staff account.
- `snapshot`: immutable validated JSON v1 `{ version:1, questions:[{ sourceQuestionId,type,prompt,points,options:[{ id,text,isCorrect }] }], shuffleQuestions,shuffleOptions,durationMinutes }`. Server-only stores `isCorrect`; public mapper explicitly drops it. Only `SINGLE_CHOICE` / `MULTIPLE_CHOICE` allowed when starting a new room; history retains legacy rows.
- An existing `Assignment.joinCode` is NOT reused for a new room. Keep it until old clients are migrated; 6-digit new room codes are generated with cryptographic randomness and are unique *historically* via DB constraint, which exceeds the spec's active-room-only uniqueness guarantee.

## Task 1: Expand schema and backfill historical room state

**Files:** Modify `prisma/schema.prisma`; create `prisma/migrations/20261018110000_independent_test_rooms/migration.sql`; create `apps/api/test/rooms-postgres.test.cjs`.

**Interfaces:** Produces `prisma.testRoom`, `prisma.roomParticipant`, and nullable `Submission.roomId`/`Submission.participantId` for Tasks 2–5. Migration creates a legacy room for every assignment with pre-existing submissions or lobby settings and maps submissions to its room and distinct participants. Backfill identifiers deterministic per source row; SQL is repeat-safe where possible; migration never deletes answers/questions.

- [ ] **Step 1 — RED:** Write `rooms-postgres.test.cjs` integration test `migration_preserves_legacy_rows_and_links_submissions`: insert one legacy assignment, two duplicate-name submissions and their answers in a **disposable** PostgreSQL schema, apply migration, assert preserved answer counts, distinct `participantId`s, one migrated `roomId`, original `assignmentId`; also assert a new `TestRoom` relation exists. Refuse to run unless `TEST_DATABASE_URL` names a test/audit database (match existing `assignments-postgres.test.cjs`).
- [ ] **Step 2 — Verify RED:** Run `TEST_DATABASE_URL=postgresql://.../schoolcrm_test npm test` (with isolated test DB); expected migration/table assertion failure before schema change, NOT connectivity or fixture error. Isolate destructive setup only to disposable schema.
- [ ] **Step 3 — GREEN:** Add `RoomStatus`, `TestRoom`, `RoomParticipant`, nullable submission refs and indexes; write additive SQL migration with backfill while preserving legacy columns. Do not modify `QuestionType` enum yet.
- [ ] **Step 4 — Verify GREEN:** Run `npx prisma validate && npx prisma generate && npm test`; run integration against disposable DB; assert old tables/answers unchanged, new links valid.
- [ ] **Step 5 — Commit checkpoint:** `git add prisma/schema.prisma prisma/migrations/20261018110000_independent_test_rooms/migration.sql apps/api/test/rooms-postgres.test.cjs && git commit -m "feat(rooms): add backward-compatible room schema"` only if actual `.git` exists. Otherwise save reviewable patch artifacts.

## Task 2: Create multiple teacher-owned rooms with 6-digit codes

**Files:** Create `apps/api/src/assignments/rooms.dto.ts`, `rooms.service.ts`, `rooms.controller.ts`, `apps/api/test/rooms-foundation.test.cjs`; modify `assignments.module.ts`.

**Interfaces:** Implements `createRoom`, `listRooms`, `getRoom`, and staff routes defined above. Unit tests use actual `RoomsService` with a deterministic Prisma fake; integration test exercises unique DB constraint in PostgreSQL.

- [ ] **Step 1 — RED:** Write `creates_two_rooms_for_same_assignment_with_different_codes` asserting `/^\d{6}$/` for each code and distinct ids/codes. Write `teacher_cannot_list_read_or_start_another_teachers_room` (foreign teacher gets 404). Write `concurrent_code_collision_retries_on_P2002` (force first DB unique failure; second generated code succeeds). Write `lobby_target_rejects_41`.
- [ ] **Step 2 — Verify RED:** `npm run build --workspace @school-crm/api && node --test apps/api/test/rooms-foundation.test.cjs`; expected missing `RoomsService`/route assertions, not syntax errors.
- [ ] **Step 3 — GREEN:** Implement room `createRoom` using role and creator ownership check, cryptographic 6-digit generator (exclude values already owned), DB uniqueness + bounded retries on Prisma `P2002`, staff scoping and DTO validation; expose controller/DI. Reject DRAFT assignments unless explicitly published; do not mutate assignment joinCode.
- [ ] **Step 4 — Verify GREEN:** Same focused tests; run `npm test` including legacy auth/room tests and integration when configured; prove absence of host port dependency.
- [ ] **Step 5 — Commit checkpoint:** Commit reviewed files with `feat(rooms): create independent teacher-owned rooms` only if `.git` exists.

## Task 3: Independent identities and secure reconnect by opaque token

**Files:** Create `apps/api/src/assignments/room-session.guard.ts`; modify `rooms.service.ts`, `rooms.controller.ts`, `rooms.dto.ts`, `assignments.module.ts`; extend `apps/api/test/rooms-foundation.test.cjs` and `rooms-postgres.test.cjs`; later hook into `apps/web/app/client-utils.ts`.

**Interfaces:** Implements `joinRoom(code, firstName, lastName, token?, ip?)`, `getStudentRoom(roomId, token)`, and `RoomSessionGuard`. Token is 32 random bytes base64url; SHA-256 hex of token is persisted, never token itself. A valid token can only access its own room/participant. No school-wide student login is required for v2 join; staff auth remains JWT.

- [ ] **Step 1 — RED:** Write tests `duplicate_names_create_distinct_participants`, `token_of_student_a_cannot_read_student_b_attempt`, `same_token_resumes_existing_attempt_after_reconnect`, `unknown_room_code_does_not_enumerate_rooms`, `tokenless_known_name_running_room_creates_new_zero_answer_attempt_and_audit`, `tokenless_unknown_name_running_room_rejected_409`. Add DB race test `parallel_join_cannot_exceed_target` for a 1-seat lobby.
- [ ] **Step 2 — Verify RED:** Run focused service tests; expected missing methods/wrong identity behavior. Run integration only with `TEST_DATABASE_URL` isolated instance.
- [ ] **Step 3 — GREEN:** Implement `roomParticipant` creation in a serialized transaction (`SELECT ... FOR UPDATE` room), normalization via `normalizeName`, opaque-token validation, role-separated guard, hashed persistence, unique `participantId`, room-scoped attempt/resume. On tokenless reentry after start match **only pre-start roster** by normalized name, create distinct participant and new attempt; audit `TOKENLESS_REENTRY` without exposing name-to-token mapping. A successful token refresh must not change question ordering. Do not disclose correct answers in `StudentRoomView`.
- [ ] **Step 4 — Verify GREEN:** Focused tests + `npm test`; attempt to reuse bearer token across rooms and observe 403/404; ensure no token echoed in logs.
- [ ] **Step 5 — Commit checkpoint:** Commit with `feat(rooms): isolate participant sessions and reconnect` only in a git checkout.

## Task 4: Freeze snapshot and start room before lobby target

**Files:** Modify `rooms.service.ts`, `rooms.controller.ts`, `rooms.dto.ts`, `assignments.module.ts`; extend `rooms-foundation.test.cjs`, `rooms-postgres.test.cjs`.

**Interfaces:** Implements `startRoom(roomId, actor)`; `TestRoom.snapshot` receives version 1 immutable question data; `TestRoom.startedAt` is authoritative; source `Assignment` remains editable and separately versioned. `getStudentRoom` maps immutable snapshot without correct-option flags. A v2 room never starts if a referenced question type is not choice-only.

- [ ] **Step 1 — RED:** Tests: `teacher_can_start_room_at_7_of_10`; `room_start_is_idempotent_under_parallel_requests`; `room_after_start_rejects_new_name`; `snapshot_not_affected_by_assignment_question_edit`; `snapshot_never_exposes_isCorrect_to_student`; `other_teacher_cannot_start_room`; `legacy_numeric_question_prevents_new_room_start_without_removing_history`.
- [ ] **Step 2 — Verify RED:** Focused room tests fail at missing/incorrect room start behavior; integration race runs on disposable PostgreSQL.
- [ ] **Step 3 — GREEN:** Transaction-lock room and read questions/options, verify only choice types and valid points, serialize snapshot and set room status/start time atomically, transition only WAITING attempts for that room to IN_PROGRESS with `startedAt` set to room start; reject new participants not on pre-start roster. No pause controls.
- [ ] **Step 4 — Verify GREEN:** `npm run build --workspace @school-crm/api && node --test apps/api/test/rooms-foundation.test.cjs apps/api/test/rooms-postgres.test.cjs`, `npm test`, with explicit note if DB tests skip.
- [ ] **Step 5 — Commit checkpoint:** Commit with `feat(rooms): freeze test snapshot at room start` only in a git checkout.

## Task 5: Wire minimal v2 room UX without breaking v1

**Files:** Modify `apps/web/app/page.tsx`, `apps/web/app/client-utils.ts`, `apps/web/test/client-utils.test.mjs`; modify existing API room routes only to provide backward-compatible forwarding where genuinely needed.

**Interfaces:** Staff assignment card lists per-room codes/target/count/start; create-room action calls v2 staff API. Student join is code + first/last name; `localStorage` namespaced as `zaily-room-session:<roomId>` to survive browser restart; the opaque token travels only in authenticated v2 room requests (never URL). `readStorage` etc. remain for v1 until cutover. Browser does not persist answer keys.

- [ ] **Step 1 — RED:** Web tests: `room_v2_session_key_is_per_room`, `room_v2_login_does_not_require_school_access_code`, `rehydrate_same_room_from_storage`, `staff_room_list_displays_owned_rooms_only`, `ranking_is_not_shown_while_waiting_or_running`; add API snapshot/redaction test if missing. Use existing native web tests where possible; browser e2e is separate phase when Playwright harness is available.
- [ ] **Step 2 — Verify RED:** `npm run test:web`; expect missing exported helpers/UI contract failures, not unavailable runtime.
- [ ] **Step 3 — GREEN:** Add small typed web API wrappers and room list/join/status components within existing page patterns; preserve RU/KZ labels and accessibility. Do not remove legacy student auth screen until v2 end-to-end smoke passes; designate v2 as primary new test path after integration.
- [ ] **Step 4 — Verify GREEN:** `npm run test:web && npm test && npm run build`; browser smoke staff A creates two rooms, teacher B sees none, student joins one and reloads, second same-name session stays independent, start-now locks roster.
- [ ] **Step 5 — Commit checkpoint:** Commit with `feat(rooms): enable independent room flows in web client` only in a git checkout.

## Task 6: Phase-1 full integration and safe handoff

**Files:** Extend `apps/api/test/rooms-postgres.test.cjs`, `apps/api/test/rooms-foundation.test.cjs`; update `README.md`, `docs/superpowers/plans/2026-10-18-school-platform-roadmap.md` with verified execution notes.

**Interfaces:** Complete first independently usable deliverable: reusable test → room A/B → separate rosters → staff start → student protected snapshot; no destructive cleanup, no credential leakage.

- [ ] **Step 1 — RED:** Write end-to-end integration `one_assignment_two_concurrent_rooms_independent_snapshots_and_join_counts` and `migrate_old_assignment_and_preserve_answers` against disposable test DB; test cross-role denial from real controller guards.
- [ ] **Step 2 — Verify RED:** Run test before final wiring; document expected specific failure.
- [ ] **Step 3 — GREEN:** Fill only integration gaps exposed by tests; add database index or isolation fix only with a failing test.
- [ ] **Step 4 — Verify GREEN:** `npx prisma validate && npm run build && npm test`; run dedicated DB test with explicit `TEST_DATABASE_URL`; exercise production read-only health after new app build and verify no host binding on 3000. Document skipped DB tests honestly if a test DB is not provided.
- [ ] **Step 5 — Handoff:** Publish changed files/patch and test report; real git commit only if working in an actual git repository. Do **not** delete legacy `Assignment.joinCode`/legacy `Submission` fields at this stage. Phase 2 handles scoring, proctoring and all lifecycle behaviors.

## Baseline notes (verified from uploaded source, before execution)

- `prisma/schema.prisma:120–149` has `Assignment.joinCode/lobbyTarget/roomStartedAt` directly on assignment; `Submission` at 177–209 has no room/participant refs.
- `apps/api/src/assignments/assignments.service.ts:318–423` joins/starts on assignment; its shared-student `studentIdentityKey` hashes `user.sub` (the latter is based on normalized name).
- `apps/api/src/auth/jwt-auth.guard.ts` requires school-shared JWT for student endpoints, not the approved code+name-only room flow.
- `apps/web/app/page.tsx` currently uses `sessionStorage` for `ATTEMPT_KEY`, not durable across full browser restart.
- `apps/api/test/assignments-postgres.test.cjs` skips unless disposable `TEST_DATABASE_URL` is configured; old numeric-question integration test must remain historical or be updated after v2 behavior is introduced.
- `compose.production.yaml` uses host `8080`, internal web `3000`. Do not confuse internal container port with host port conflict.

## Phase boundary

Phase 1 intentionally does **not** implement LiveKit, 3-warning finalization, analytics, results-db, installer changes, or the full ranking. Those are independently testable phases in the roadmap; mixing them with the DB identity migration raises regression risk.

## Execution record — 2026-10-18

Implemented in source:

- Additive Prisma schema and `20261018110000_independent_test_rooms` migration with legacy assignment/submission backfill.
- Staff room APIs, room-specific code generation/retry, ownership scoping, participant joining with duplicate names, room token hashing/reconnect, tokenless reentry isolation, answer-key redaction, start snapshot and per-attempt question/option order.
- V2 choice answer autosave, server timer sweep, scoring, room completion and room leaderboard.
- Staff room controls and direct `/room` student flow; existing v1 student login/routes remain available during transition.
- Focused domain tests and migration safety test.

Verification still required before Phase 1 can be marked complete:

- Run `rooms-postgres.test.cjs` and verify historical answer preservation against a disposable PostgreSQL test database (`TEST_DATABASE_URL`). It currently skips because none is configured.
- Exercise the `/room` and staff flows in a browser with two users and two rooms, including refresh/reconnect and teacher ownership.
- Verify the migration on a copy of the intended school database before deployment. No existing database has been modified in this turn.
