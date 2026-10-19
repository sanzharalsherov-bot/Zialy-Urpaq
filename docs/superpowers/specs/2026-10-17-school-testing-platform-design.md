# Zaily Urpaq School Testing Platform — Design Specification

**Date:** 2026-10-17
**Status:** Approved design, ready for implementation planning
**Source baseline:** uploaded `school-crm.zip`

## 1. Goal

Evolve the existing School CRM testing module into a reliable classroom testing platform for Windows-hosted school deployment. The system must support reusable test templates, multiple concurrent test rooms, strict anti-cheating controls, live screen monitoring, resilient autosave/reconnect, weighted scoring, analytics, separate result export, and Windows/Cloudflare deployment without conflicting with another application already using localhost port 3000.

The target operating envelope is up to 10 active rooms with roughly 30–40 students per room, with architecture able to tolerate 300–400 connected students.

## 2. Current Baseline and Required Corrections

The uploaded project already contains working pieces for assignments, room codes, lobby state, timer/autosave, randomized question and option order, proctor events, JPEG screen snapshots, Word import, CSV/SQLite result export, Windows packaging, Caddy, and Cloudflare Tunnel support.

The following current design choices conflict with the approved product behavior and must be corrected:

1. `Assignment` currently contains `joinCode`, `lobbyTarget`, and `roomStartedAt`, so one test cannot safely run as multiple independent rooms.
2. `Submission` identity is tied too closely to a deterministic identity key; duplicate student names must remain distinct.
3. On the third proctor violation, the current code deletes saved answers. Approved behavior is to preserve answers, grade them, and finish the attempt.
4. Screen monitoring is implemented as periodically uploaded JPEG frames. Approved behavior is real-time WebRTC via LiveKit, with JPEG only as an optional fallback.
5. Result export currently builds a SQLite archive. Approved primary destination is a separate PostgreSQL results database, while CSV remains available as a convenience export.
6. Question types include text/numeric/file-oriented modes. Approved testing UI supports only single-choice and multiple-choice questions.

## 3. Domain Model

### 3.1 Assignment

`Assignment` becomes a reusable test template. It owns:

- title and description;
- subject/class metadata;
- time limit;
- question shuffle setting;
- option shuffle setting;
- reusable questions and answer options;
- editable draft/published lifecycle;
- creator ownership.

It does **not** own live-room state or a single room code.

### 3.2 TestRoom

Introduce `TestRoom` as a separate entity representing one run of an assignment.

Suggested fields:

- `id`
- `assignmentId`
- `creatorId`
- `joinCode`
- `status`: `LOBBY | RUNNING | FINISHED | CANCELLED`
- `lobbyTarget`
- `startedAt`
- `finishedAt`
- `durationMinutes`
- `snapshotVersion`
- `createdAt`
- `updatedAt`

Constraints:

- `joinCode` is exactly six numeric digits.
- An active room code must be unique.
- A finished room code is not immediately reused.
- A teacher may see and control only rooms belonging to tests they own.
- An administrator may see all rooms.

One assignment may have any number of rooms, including concurrent rooms.

### 3.3 Room Snapshot

When a room starts, the system freezes the effective test definition for that room.

The snapshot must include at least:

- question IDs and prompts;
- question types;
- question points;
- answer options;
- correct-option mapping;
- shuffle settings;
- room time limit.

Edits to the source assignment after room start must not alter a running or completed room.

Implementation may use dedicated snapshot tables or a validated immutable JSON snapshot. The chosen representation must keep analytics queryable by stable source question IDs.

### 3.4 Room Participant

Introduce a room-scoped participant identity separate from account identity.

Suggested fields:

- `id`
- `roomId`
- `firstName`
- `lastName`
- `deviceSessionHash`
- `joinedAt`
- `lastSeenAt`
- `connectionStatus`

Duplicate names are allowed.

The visible student flow requires only:

- first name;
- last name;
- six-digit room code.

The browser receives a private random session token after first join. Only a hash is stored server-side.

### 3.5 Attempt / Submission

`Submission` becomes room-scoped by adding `roomId` and `participantId`, while retaining the assignment relationship for reporting.

Each attempt stores:

- `attemptNo`
- start/end timestamps;
- status;
- total score;
- question order;
- option order;
- warning count;
- finish reason;
- ranking duration;
- snapshot reference/version;
- export state.

A participant may have multiple attempts when staff explicitly permits a retry.

The main room ranking uses only the **latest** attempt for each participant. Previous attempts remain in history.

## 4. Question Model and Scoring

Only these types are allowed in the active test builder and Word import:

- `SINGLE_CHOICE`
- `MULTIPLE_CHOICE`

Text, long-text, numeric, matching, fill-blank, and file-upload modes are removed from the active builder flow and rejected by new Word imports.

Existing legacy rows of unsupported question types must remain readable for migration safety, but cannot be used to start a new room until converted or removed.

Each question has `points`, defaulting to `1`. Negative points are not allowed.

Scoring:

- single-choice: full question points only when the one correct option is selected;
- multiple-choice: full question points only when the selected set exactly equals the full correct set;
- partial multiple-choice selections receive `0`;
- any selected incorrect option receives `0`;
- unanswered receives `0`;
- total score never becomes negative.

Percentage:

`earnedPoints / maximumPoints * 100`

## 5. Word Import

Word import and the web builder must create the same domain objects and validation rules.

The Word template supports:

- title;
- subject;
- description;
- time limit;
- shuffle settings;
- `SINGLE_CHOICE`;
- `MULTIPLE_CHOICE`;
- per-question points;
- marked correct options.

It no longer supports text-answer questions.

Validation rejects:

- no correct answer;
- more than one correct answer for `SINGLE_CHOICE`;
- fewer than one correct answer for `MULTIPLE_CHOICE`;
- invalid points;
- unsupported types;
- malformed or oversized DOCX content.

## 6. Lobby and Start Rules

Before room start:

- students may join using code + first name + last name;
- lobby shows `current/target`, e.g. `27/30`;
- teacher/admin can wait for the target or choose **Start now**;
- assignment and room settings remain editable until start.

At start:

- the test snapshot is frozen;
- room status becomes `RUNNING`;
- server start time becomes authoritative;
- all participants already in the lobby become eligible attempts;
- first-time entrants whose name was not present in the pre-start room roster cannot join after start.

An existing participant may reconnect to the same unfinished attempt only when the browser presents the valid saved session token.

If the token is lost or the student uses another device after the room starts, the server must never restore an old attempt by name alone. To preserve the user's selected behavior while keeping the room closed, a tokenless re-entry is accepted only when the same first/last name was already present in the pre-start roster; it creates a **new attempt/session** marked `TOKENLESS_REENTRY`. It does not restore or merge with the previous attempt. Because duplicate names are allowed, staff must be able to see these separate records clearly. A completely new name remains rejected after start.

## 7. Timer and Autosave

The server is authoritative for test time.

Rules:

- each answer is autosaved immediately;
- question and option order are generated once per attempt and persisted;
- F5/reload does not count as a violation;
- reconnect after a network interruption does not count as a violation;
- browser restart may restore the same attempt when the session token survives;
- the timer never pauses because of reload, disconnect, or browser restart;
- if time expires while the client is offline, the server finalizes the attempt;
- users may finish early with an explicit finish action.

Server-side finalization must be idempotent so timer expiry, manual finish, and reconnect cannot create duplicate grading events.

## 8. Anti-Cheating / Proctoring

### 8.1 Violation Episodes

A continuous period away from the test counts as **one** violation episode even if several low-level browser events occur during that episode.

Examples that begin or contribute to an episode:

- another browser tab becomes active;
- a new tab is opened and the test loses visibility;
- browser window is minimized;
- another desktop application gets focus;
- mobile browser goes to background;
- device is locked;
- test tab is closed;
- screen sharing is manually stopped.

Even a brief intentional departure counts.

A new violation is counted only after the student has returned to the test and then leaves again.

### 8.2 Network Failures

Network/WebRTC failures are technical events, not automatic cheating violations.

The system logs:

- disconnect;
- reconnect;
- WebRTC timeout;
- screen-sharing transport failure.

A network failure becomes a proctor violation only if there is separate evidence of an intentional prohibited action, such as an explicit manual `screen-share-ended` event.

### 8.3 Three-Warning Rule

- first violation: warning 1/3;
- second violation: warning 2/3 and high-visibility staff status;
- third violation: server automatically finalizes the attempt.

Third-violation finalization must:

- preserve all saved answers;
- grade the preserved answers;
- calculate score, percentage, time, and rank;
- mark the finish reason `PROCTORING_VIOLATION_LIMIT`;
- retain the student in the ranking;
- show the student the ordinary result screen plus a clear violation notice.

No saved answers are deleted.

### 8.4 Close vs Reload

A normal reload (`F5`) is allowed and not a violation.

A true tab/window close during an active test is a violation, but the same browser may later restore the unfinished attempt through its session token unless the third violation already finalized it.

Implementation should use a combination of visibility, page lifecycle, heartbeat, and reconnect correlation rather than trusting `beforeunload` alone.

## 9. Room-Code Security

Room codes are six numeric digits.

Rate limiting uses a combined device/session token and network signal rather than school IP alone.

Approved rule:

- three rejected room-code attempts from the same device identity trigger a 15-minute block;
- the source IP is stored as an additional signal;
- a successful room join resets the device failure counter;
- students behind one school NAT must not block classmates;
- all rejected attempts and blocks are recorded in a security log;
- mass guessing from one IP across many device tokens is flagged for staff review.

Redis may store short-lived counters/blocks; persistent security events stay in PostgreSQL.

## 10. Live Screen Monitoring

### 10.1 Transport

Primary screen transport is WebRTC through a self-hosted LiveKit SFU.

The existing JPEG frame path may remain as a compatibility fallback but is not the primary experience.

The web application must never silently start screen capture. Browser/OS permission is required.

### 10.2 Desktop

On supported Windows browsers:

- screen sharing is required before the attempt begins;
- the student shares the full screen where the browser permits it;
- manual termination of sharing is a proctoring event;
- teacher/admin receives live video.

### 10.3 Mobile

At room entry, capability detection determines monitoring mode:

- `LIVE_SCREEN` when full-screen capture is supported;
- `BROWSER_MONITORING_ONLY` when the mobile browser does not expose full-screen capture.

In browser-monitoring-only mode the test is still allowed, but visibility/background events are enforced strictly.

### 10.4 Teacher Monitor UI

A teacher sees only rooms for their own tests.

For one room, the monitor shows all students in a responsive grid. Each card displays:

- live screen;
- first/last name;
- progress such as `12/30`;
- warnings such as `1/3`;
- connection status;
- attempt status.

Selecting one card enlarges that screen while the remaining students stay in a compact side/bottom strip. Selecting another student switches the focused view. **Collapse** returns to the full grid.

Administrators have equivalent access across all rooms.

For bandwidth control, thumbnails use reduced resolution/frame rate while the focused stream subscribes at higher quality. LiveKit adaptive stream/simulcast should be used where supported.

## 11. Staff Controls

Teacher/admin can:

- start a room before lobby target is reached;
- finish one student's attempt with confirmation;
- finish the whole room with confirmation;
- authorize a retry for a specific participant;
- retry a failed results export.

There is no pause feature. Once a room starts, its server timer continues until completion.

Every staff action is written to the audit log with actor, timestamp, room/attempt, and action type.

## 12. Result Screen and Ranking

Students do not see ranking during an active test.

After completion they see:

- earned score;
- maximum score;
- percentage;
- elapsed time;
- ranking place;
- top-ranking summary;
- violation count/status.

Students do **not** see correct answers or question-by-question corrections.

Ranking comparator:

1. higher earned points;
2. fewer proctor violations;
3. lower elapsed time.

For participants with authorized retries, only the latest attempt participates in the main ranking.

Attempts finalized because of violations remain in the main ranking with a visible violation marker.

## 13. Analytics

Teacher/admin analytics are room-aware and assignment-aware.

Per question:

- correct count and percentage;
- incorrect count and percentage;
- unanswered count;
- selections per option;
- common multiple-choice combinations;
- average answer duration;
- list of students who answered incorrectly.

Views support:

- one room;
- comparison of multiple rooms for the same assignment;
- historical runs.

Analytics use stable question IDs from the room snapshot so shuffled presentation does not distort reporting.

## 14. Separate Results PostgreSQL

Primary operational data remains in the main PostgreSQL database.

A second PostgreSQL service, `results-db`, receives durable exported result records.

Export behavior:

- an attempt is queued for export after finalization;
- successful state: `EXPORTED`;
- transient failure: `PENDING` or `FAILED`;
- test execution never fails because results-db is offline;
- staff may manually retry export;
- export is idempotent using stable room/attempt identifiers;
- duplicate retries update/upsert rather than duplicate rows.

Export includes at minimum:

- assignment and room identifiers;
- room metadata;
- participant name and participant ID;
- attempt number;
- score/maximum/percentage;
- elapsed time;
- warnings and finish reason;
- per-question response result;
- question analytics dimensions;
- timestamps.

CSV export remains available for spreadsheet use.

The legacy SQLite exporter may be removed from the primary UI after equivalent PostgreSQL export coverage exists.

## 15. Concurrency and Reliability

Target:

- up to 10 simultaneous rooms;
- 30–40 students per room;
- 300–400 connected students as a design envelope.

Rules:

- API rate limits must not use source IP alone;
- grading/finalization must be idempotent;
- result export runs out-of-band from request-critical test flow;
- presence and short-lived security state may use Redis;
- source-of-truth room/attempt/result state remains PostgreSQL;
- LiveKit handles media, not the application API;
- no full-resolution media is persisted by default;
- live video is transmitted only while staff monitoring is active/authorized.

Load validation will include HTTP concurrency, room joins, autosave bursts, heartbeat traffic, ranking reads, and LiveKit signaling/media tests separately.

## 16. Deployment, Ports, and WebRTC Networking

The installed product must not conflict with another local application using port 3000.

Approved convention:

- web development: `3100`;
- installed public HTTP endpoint: `8080`;
- internal web container may continue to use container port 3000 because it is not bound directly to host port 3000;
- API remains internal behind Caddy;
- Caddy publishes the installed product on `8080`.

Production services:

- main PostgreSQL;
- results PostgreSQL;
- Redis;
- API;
- web;
- LiveKit;
- Caddy;
- optional Cloudflare Tunnel.

### Cloudflare boundary

Cloudflare Tunnel is the public entry path for the web application/API and may carry normal HTTPS/WebSocket signaling traffic. It is **not** treated as the transport for LiveKit's WebRTC media plane.

Self-hosted LiveKit requires network reachability for its configured ICE/TCP/UDP and optional TURN ports. Therefore the deployment supports two media modes:

1. **School-LAN mode (default for on-premise classroom use):** web/API may be reached through the Cloudflare hostname, while student/teacher browsers on the school network connect directly to the on-premise LiveKit media address/ports advertised for the LAN.
2. **External media mode:** when monitoring must work from outside the school LAN, LiveKit must have a separately reachable public media endpoint (for example a public IP with firewall/NAT port forwarding and TURN/TLS, or a separately hosted LiveKit/LiveKit Cloud endpoint). Standard Cloudflare Tunnel alone is not considered sufficient for the media plane.

The launcher must test WebRTC media reachability separately from the ordinary web/API health check and clearly report when the website is reachable but LiveKit media is not.

Tunnel tokens, LiveKit secrets, database passwords, and other credentials remain outside source control.

## 17. Windows Launcher and Installer

The existing launcher/installer flow is preserved and extended.

Supported target is Windows 10/11 environments that satisfy Docker Desktop/WSL requirements.

Launcher responsibilities:

- verify/install prerequisites where appropriate;
- detect Docker/WSL readiness;
- start required containers;
- show health for API, main DB, results DB, Redis, LiveKit, and Cloudflare;
- open the application;
- expose Cloudflare setup separately;
- report actionable failures.

The launcher must not require or occupy host port 3000.

Installer build is performed only after application, migration, production-compose, and smoke tests pass.

## 18. Migration Strategy

Implementation should preserve existing assignment and submission data.

Migration sequence:

1. create `TestRoom`, participant, snapshot, export-state structures;
2. create one migrated room for each legacy assignment that currently contains room fields when needed for history;
3. move/derive room-specific state from `Assignment` into `TestRoom`;
4. connect existing submissions to migrated room/participant records;
5. retain legacy assignment fields temporarily if required for backward-compatible deployment;
6. update application reads/writes to room entities;
7. remove/deprecate legacy room fields only after tests prove no runtime dependency remains.

Unsupported legacy question types are not deleted automatically. They remain historical but cannot launch in new rooms.

## 19. Security Requirements

- teacher ownership is enforced server-side, never only in UI;
- admin access is explicit by role;
- students cannot access monitor endpoints;
- one teacher cannot access another teacher's room streams or detailed results;
- LiveKit access tokens are short-lived and scoped to the exact room/participant role;
- screen-share publication permission is student-scoped;
- teacher subscription permission is room-scoped;
- no secrets are returned to browser clients;
- room-code rejection logs do not disclose valid room codes;
- device/session tokens are random and stored hashed;
- export DB credentials are server-only;
- all manual termination/retry actions are audited.

## 20. Testing Strategy

Implementation follows test-driven development.

For every behavior change:

1. add a minimal failing test;
2. run it and verify the expected failure;
3. implement the smallest production change;
4. rerun the focused test;
5. run the broader suite;
6. refactor only while green.

Required test groups:

### Domain/API
- one assignment creates multiple independent rooms;
- six-digit active-room code uniqueness;
- teacher ownership and admin access;
- start-now before lobby target;
- no new participant after start;
- token reconnect vs tokenless new attempt;
- duplicate names remain distinct;
- question snapshot immutability;
- weighted single/multiple scoring;
- strict multiple-choice all-or-nothing behavior;
- latest-attempt ranking;
- ranking tie-break rules;
- server timer and idempotent finalization;
- manual participant/room finish;
- third violation preserves and grades answers;
- continuous-away events deduplicate into one warning;
- reload/network reconnect do not warn;
- tab close/background transition does warn;
- code guessing blocks device, not whole NAT;
- automatic export, failed export, idempotent retry.

### Word Import
- accepts only single/multiple choice;
- accepts points;
- rejects unsupported types;
- validates correct-answer counts;
- preserves Unicode and safe DOCX parsing.

### Web
- builder exposes only two question types;
- lobby current/target and start-now flow;
- result page hides correct answers;
- ranking hidden during active test;
- teacher room filtering;
- monitor grid/focus/collapse;
- warning UI;
- responsive/mobile behavior.

### LiveKit
- scoped token issuance;
- student can publish only own screen;
- teacher can subscribe only to owned room;
- reconnect handling;
- screen-share end event;
- low-quality thumbnail/high-quality focused subscription behavior.

### Load/Smoke
- concurrent room-code joins;
- autosave bursts;
- heartbeat load;
- 30–40 participants in one room;
- multiple active rooms;
- production compose health;
- installed endpoint on 8080 with host port 3000 free;
- web/API reachability and LiveKit media reachability are tested independently.

## 21. Implementation Order

1. Data model: `TestRoom`, participants, snapshots, export state.
2. Room ownership/lobby/start/close flow.
3. Session-token identity and reconnect.
4. Restrict active question types and weighted strict scoring.
5. Room-scoped attempts, retries, ranking.
6. Proctor violation episode model and third-warning finalization.
7. Staff manual controls and audit.
8. Analytics.
9. Results PostgreSQL and idempotent export/retry.
10. LiveKit token service and WebRTC client integration.
11. Teacher monitor grid/focus UI.
12. Redis-backed ephemeral security/presence where needed.
13. Production compose, launcher, Cloudflare integration.
14. Load/security/smoke tests.
15. Final Windows installer build.

## 22. Non-Goals for This Phase

- hidden or OS-level surveillance outside browser permissions;
- recording/storing full student screen video by default;
- pausing active tests;
- showing correct answers to students after completion;
- partial credit for multiple-choice;
- negative scoring;
- student accounts as a requirement for room entry;
- joining a room after it has started;
- direct use of host port 3000.

## 23. Acceptance Criteria

The implementation is acceptable when:

- one reusable test can run in multiple simultaneous independent rooms;
- room ownership is enforced correctly;
- students enter by code + name and duplicate names are safe;
- autosave/reconnect preserves attempt state and server time;
- only single/multiple choice are used for new tests;
- weighted strict scoring and ranking rules match this spec;
- three real violation episodes finish the attempt without deleting answers;
- teacher/admin can monitor live screens through LiveKit where supported;
- mobile fallback enforces browser-background violations;
- analytics and separate PostgreSQL export work;
- result export failure does not interrupt testing;
- 10-room architecture does not rely on school-IP-only limits;
- production runs on host port 8080 and does not take port 3000;
- Windows launcher starts and health-checks the full stack;
- focused tests and the complete test suite are green before installer release.
