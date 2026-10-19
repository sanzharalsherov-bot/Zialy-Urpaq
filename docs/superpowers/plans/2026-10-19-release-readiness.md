# Zaily Urpaq Release Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the school platform on a real network and devices, then produce one reproducible Windows installer for handoff.

**Architecture:** Keep the existing PostgreSQL, API, web, Caddy and LiveKit Compose stack. Verify each boundary on disposable data before touching the school installation. Build the installer only after the deployed source and recovery path pass acceptance checks.

**Tech Stack:** Windows 10/11, PowerShell, Docker Desktop/Compose, PostgreSQL, NestJS, Next.js, Caddy, LiveKit. Current deployment: school LAN only, Caddy local CA, no domain or Cloudflare Tunnel.

**Spec:** `docs/superpowers/specs/2026-10-17-school-testing-platform-design.md`; current state: `docs/superpowers/plans/2026-10-18-school-platform-roadmap.md`.

## Global Constraints

- Do not remove or migrate the existing school database before taking and restoring a verified backup on a disposable database.
- Preserve the other application on host port 3000; the production school site defaults to port 8080.
- Do not store credentials or tunnel tokens in the repository, logs or the installer archive.
- Do not rebuild the handoff installer until all source, device, media, recovery and daily-start checks pass.
- A browser cannot guarantee screen capture on every phone. If a target phone lacks `getDisplayMedia`, record the exact model/browser result and implement a supported native companion or agree on a different monitoring workflow before claiming that device is supported.

## Review Focus

- A student loses Wi-Fi during a test: saved answers and timer state remain correct after reconnection.
- Forty students join and submit at once while a teacher watches: no HTTP 500, wrong room or mixed identity.
- A teacher/student connects from another device: room and media credentials cannot be reused outside their scope.
- Windows restarts with Docker closed: one shortcut starts the same installation and data without asking for a new administrator.
- A database restore uses the wrong volume or leaves results missing: verify source and reporting counts before accepting recovery.

---

### Task 1: Close disposable QA and export verification

**Files:** `apps/api/test/qa-room-load.mjs`, `apps/api/src/assignments/results-outbox.service.ts`, `docs/superpowers/plans/2026-10-18-school-platform-roadmap.md`.

- [x] Confirm the `zaily-load-20261019` Compose project is still disposable and distinct from the user's actual school project.
- [x] Query its source submissions, export outbox and separate `ExportedResult` table: 400 graded submissions, 400 outbox entries, 400 unique exported rows, and 0 pending entries.
- [x] Export worker completed the full batch; no further export fix was needed.
- [x] Removed only `zaily-load-20261019` containers, network and its two test volumes; confirmed `school-crm-postgres` remains healthy.

### Task 2: Establish a secure, reachable address

**Files:** `compose.production.yaml`, `Caddyfile`, `packaging/windows/Configure-Cloudflare.ps1`, `packaging/windows/Ensure-MediaConfig.ps1`, `apps/api/src/assignments/livekit.service.ts`.

- [x] Final topology: school LAN only, server 192.168.10.8, gateway 192.168.10.1, Caddy tls internal and local LiveKit TCP/UDP. No public domain or Cloudflare Tunnel.
- [ ] Configure HTTPS for the site and WSS for LiveKit signaling. Check the returned LiveKit URL opens the `/livekit/rtc/v1` signaling path through Caddy.
- [ ] Verify WebRTC media reaches the LiveKit host over the configured UDP/TCP path from a second device. Cloudflare's ordinary published web route is not proof of media connectivity; check its current service terms before routing video through it.
- [ ] Repeat after a server restart. Record the stable address and required network/firewall settings in the school's handoff guide.

**Progress:** Added a hostname field to the Cloudflare setup window. Its settings helper validates a hostname, stores the Tunnel Token without logging it, collapses duplicate environment settings, and configures `wss://<hostname>/livekit` while preserving the LiveKit LAN node address. The GUI probes `https://<hostname>/api/health` and `https://<hostname>/livekit/`, checks the expected platform responses, and distinguishes a reachable endpoint from a running Tunnel whose hostname is not ready. The installer opens TCP 8080 for the site and LiveKit TCP 7881 / UDP 7882 only from `LocalSubnet` on the Private profile. Windows PowerShell tests cover initial config, hostname/token validation, reconfiguration and duplicate settings. Deployment contract tests check the Caddy signaling proxy, Compose media ports and restricted Windows Firewall rules. Compose parses with both optional profiles. Validation: full `npm test` passed (91 passed, 0 failed, 3 skipped because no isolated PostgreSQL test URL was configured); `InstallerApp.cs` compiled successfully to a temporary executable, which was deleted; changed PowerShell scripts parse without errors. The real school hostname, Tunnel, Windows Firewall rules and device connectivity remain unverified because the school domain/Tunnel setup and school LAN are not available in this workspace.

**Local integration, 2026-10-19:** Docker Engine was reached with the required host permissions. Started a disposable `zaily-netcheck-20261019` Compose project on host port 18080 using separate PostgreSQL volumes and test-only secrets. Caddy returned HTTP 200 from `/api/health`; `/livekit/` returned the LiveKit `OK` response; a valid test JWT and LiveKit v1 join request upgraded `/livekit/rtc/v1` to WebSocket (HTTP 101). Host TCP port 7881 was reachable. After `docker compose restart`, API health was again 200 and WebSocket upgrade again 101. Removed only that disposable project, network, volumes and test files; `school-crm-postgres` remained healthy. This proves the local API and signaling route, not the school's remote Cloudflare hostname, Windows LAN firewall or WebRTC media from a second school device.

**Deployment constraint:** The user confirmed that the school has no domain. Cloudflare's [production Tunnel requires a domain](https://developers.cloudflare.com/tunnel/get-started/) in its account; its [no-domain Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) gives a random URL that changes when the process restarts, is intended for development and permits at most 200 in-flight requests. A stable school URL therefore needs a school-owned domain or a separately agreed access design. Do not mark the public-address or school-device checks complete from the local integration result.

**Historical ruling (superseded by LAN-only requirements below):** Use Cloudflare Tunnel for the HTTPS website and WSS signaling, with LiveKit media directly over the school LAN for this setup — Cloudflare's web hostname is not treated as a working UDP media route. Cost if wrong: remote students outside the school LAN will need an additional publicly reachable LiveKit/TURN deployment and another verification pass.

**Deployment references:** Cloudflare requires an account and domain to publish a stable hostname ([Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/)). LiveKit lists separate signaling, ICE/TCP and ICE/UDP paths ([ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/)). Browser screen capture requires HTTPS and is not supported uniformly ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)).

### Task 3: Verify browsers and real devices

**Files:** `apps/web/app/room-screen-sharing.tsx`, room UI, relevant browser/API tests.

- [ ] Use at least two student devices and one teacher device. Complete room join, lobby, start, autosave, submit, ranking and teacher analytics on desktop and phone layouts.
- [ ] Start screen sharing on Windows and on each target Android/iPhone browser. Verify the teacher sees the correct student's stream, stopping works, and another student cannot subscribe.
- [ ] Test tab hiding, a third warning, page reload, Wi-Fi loss and recovery, expired timer and manual early submission. Confirm scores and audit events from the server rather than only the UI.
- [ ] If phone screen capture is unsupported by that browser/OS, select and implement a supported mobile companion or an agreed substitute; do not mark mobile streaming complete from a desktop test.

### Task 4: Prove backups and recovery

**Files:** `packaging/windows/Backup.ps1`, `packaging/windows/README.md`, PostgreSQL restore procedure and integration checks.

- [x] Back up both primary and results databases using the packaged script; verify both dump files exist and are nonempty. Verified on nonempty disposable QA data; school production backup remains a handoff operation.
- [x] Restore them into new disposable volumes, never into the current school volumes.
- [x] Compare account, assignment, room, submission, answer and exported-result counts; log in and open a known result after restoration. Counts and full-row digests match; restored API login and known-room analytics passed.
- [ ] Document where the school keeps encrypted/off-computer copies and a simple recovery procedure.

### Task 5: Clean Windows installation and daily start

**Files:** `packaging/windows/install.ps1`, `packaging/windows/Start-Server.ps1`, `packaging/windows/InstallerApp.cs`, `packaging/windows/Build-Installer.ps1`.

- [ ] Run a fresh installation on a clean Windows 11 machine and a supported Windows 10 machine or equivalent clean VM. Confirm Docker prerequisites, a dedicated install folder, optional desktop shortcut, admin creation, school code and port 8080.
- [ ] Reboot each machine, close Docker Desktop, use the shortcut and confirm the same accounts and test data return without installer prompts.
- [ ] Install again over the same folder and prove it updates code without resetting the databases or administrator.
- [ ] Run `npm test`, isolated PostgreSQL integration tests, production web/API builds and Compose health checks against the exact release source.
- [ ] Only then build the installer, copy it to a USB drive, install from that copy on a clean machine, and compare package checksums.

### Task 6: Handoff and acceptance

**Files:** `packaging/windows/README.md`, release checklist and the final USB transfer folder.

- [ ] Put the verified installer, checksums, concise Russian school guide and backup/recovery instructions in one transfer folder; exclude `.env`, passwords, QA databases and temporary artifacts.
- [ ] Demonstrate admin, teacher and student flows with the school's staff; hand over control of the server computer, permanent local CA, LAN address reservation and backup location to the school.
- [ ] Record the tested Windows versions, phone models/browsers, network path, simultaneous-user result and any unsupported mobile capture cases. Mark the release ready only when all required school devices pass.

## Progress — 2026-10-19

- Task 1 completed. The 400-student local load run and separate database export reconciled with no pending items. The temporary test stack was removed; the existing school PostgreSQL container is healthy.
- Current: Task 2, complete trusted LAN device HTTPS/WSS and real media acceptance.

## Resumed verification — 2026-10-19 (LAN-only decision)

Authoritative supplied documents, copied verbatim:
- [Development handoff](../../context/2026-10-19-development-handoff.md).
- [Full requirements](../../context/2026-10-19-full-requirements.md).

Ruling: these requirements supersede the earlier Cloudflare topology and hostname prerequisite. Historical checks above remain evidence only for their stated environment. Work continues in the supplied source folder; it currently has no Git metadata, so no commit or worktree was created.

- [x] Docker labels identify project `zaily-lancheck-20261019`, base `compose.production.yaml`, override `tmp/lancheck-20261019/override.yaml`, working directory equal to this project folder.
- [x] Confirmed actual host IPv4 `192.168.10.8`, gateway `192.168.10.1`. Source of loopback configuration: `tmp/lancheck-20261019/test.env`.
- [x] Saved a local environment rollback copy; corrected SCHOOL_LAN_IP, LIVEKIT_NODE_IP and LIVEKIT_PUBLIC_URL only in that disposable environment. Both env files are excluded through `.gitignore`; no secrets are copied into documentation.
- [x] Compose config validation passed with the explicit test env/override; recreated only test Caddy, API and LiveKit using `--no-deps --no-build`. No database service was recreated and no volume was removed. Caddy validation returned `Valid configuration`.
- [x] Node HTTPS verification with the existing explicit `root.crt`, normal hostname checking and certificate verification enabled returned HTTP 200 for `/api/health` and `/livekit/`, `authorized=true`, SAN `IP Address:192.168.10.8`. Same checks passed after restarting only those three test services. This verifies trust with an explicitly supplied root, not Windows/browser-wide trust.
- [x] TLS request with WebSocket upgrade headers to `/livekit/rtc/v1` without a token returned HTTP 401. This verifies routing/auth rejection only; authenticated HTTP 101 and actual media remain unchecked for this new LAN configuration.
- [x] Test ports remain HTTP 18080, HTTPS 18443, media TCP 7881 / UDP 7882. Web's 3000 is container-internal only. Both test PostgreSQL containers and `school-crm-postgres` remain healthy.
- [ ] Verify permanent installation CA ownership/fingerprint and distribute trust to intended school clients; no CA was installed in Windows trust stores during this work.
- [ ] Authenticate WSS from a second device, publish a real student screen and confirm the correct teacher sees it over school Wi-Fi; repeat after restart.
- [ ] Record device/browser versions, firewall behavior, stable address reservation and final installation ports. 18443 remains a temporary test port.

Task 2 remains incomplete until real device/media and browser trust acceptance. Tasks 3–6 remain unaccepted; no final installer was built. No application source changed, so application test/build results from earlier runs were not reclassified as fresh verification.

## Continued execution — 2026-10-19

- Authenticated LAN WSS: `node apps/api/test/qa-lan-signaling.mjs tmp/lancheck-20261019/test.env tmp/lancheck-20261019/root.crt` returned HTTP 101, trusted TLS and SAN IP 192.168.10.8. A real browser media stream is still required.
- Found a requirement violation: a known roster name could create a fresh participant after room start without a session token. Updated the running-room guard to reject all tokenless new joins; valid session-token resume remains supported. Regression test failed before the fix and passed after it. Removed now-unreachable running-room creation/audit branches. No schema changes.
- Built the corrected API into its own `zaily-lancheck-20261019-api:readiness` image. Switched only test API to it after backing up both test databases. Current overrides: `tmp/lancheck-20261019/readiness-override.yaml` (base Compose and explicit test.env remain required).
- HTTPS API acceptance with two synthetic students sharing the same name passed: distinct participants, early room start, no new tokenless join after start, redacted keys, autosave, session resume with the same attempt/answers/start time, score 2, idempotent repeated submit, third hidden episode retaining score 2, and teacher analytics for two completed attempts. This is API acceptance, not physical Wi-Fi/browser acceptance. Script: `apps/api/test/qa-lan-acceptance.mjs`.
- Backups and restore: exact packaged Backup.ps1 ran from an isolated staging copy. Both nonempty custom dumps passed pg_restore listing and restored to new volumes on a separate network without published host ports. Matched full-row digests and counts: User 1, Assignment 1, TestRoom 1, RoomParticipant 2, Submission 2, Answer 2, ResultExportOutbox 2, ExportedResult 2. Restored API login and known-room analytics passed. Five PostgreSQL tests passed, including the three normally skipped database integrations. The first restore API probe correctly refused missing WEB_ORIGIN; corrected only the test runner and repeated successfully in fresh resources. Both successful and failed restore resources were removed after ownership checks. Dumps/SHA256/report retained under ignored `tmp/recovery-20261019`. Script: `apps/api/test/qa-backup-recovery.mjs`.
- Fresh `npm test`: 95 total, 92 passed, 0 failed, 3 DB-only skips; the skipped cases passed separately in restored PostgreSQL. API production build, Next.js production build, all packaged PowerShell syntax checks and C# installer compilation passed. Initial sandbox web build failed on path access; elevated rerun succeeded. C# was compiled only to ignored tmp for validation; no final installer was packaged.
- Found stale test web image: `/room` returned 404 despite current source supporting it. Built `zaily-lancheck-20261019-web:readiness` and replaced only the test web container. Both `/` and `/room`, and every referenced JS/CSS asset, now return HTTP 200 over verified LAN TLS.
- Independent static review found no Critical/Important issues in the room fix and QA scripts. Deferred minor: acceptance/signaling tools rely on the supplied test environment destination; strengthen disposable identity validation before reuse elsewhere. Recovery already checks source project ownership.
- User device: iPhone 15 Pro Max / Safari; iOS version not yet recorded. HTTPS initially showed a blank screen; plain HTTP health also timed out. Host investigation proves active Wi-Fi profile is Public and two explicit Public Docker block rules cover all TCP/UDP ports; the existing Zaily 8080 rule applies only to Private. This explains an inbound firewall obstacle; phone reachability after correction still requires a device retest.
- Prepared and dry-ran `tmp/lancheck-20261019/Enable-TestLanFirewall.ps1`: retain Public Docker blocks on all other ports, except TCP 7881/18080/18443 and UDP 7882, and allow these only to local address 192.168.10.8 from 192.168.10.0/24. Exhaustive range verification preserves every other port. Original settings would be saved for rollback. Application is pending explicit user approval because existing shared Windows Firewall rules must be changed. Network profile and unrelated project settings stay unchanged.

Remaining release gates: approved/retested LAN firewall, verified device CA trust and actual media, full PC/phone browser scenarios including real Wi-Fi loss, off-server encrypted backup custody, clean Windows 10/11 install/reboot/update/USB acceptance. Do not mark release ready from synthetic checks.

### Approved LAN firewall application — 2026-10-19

- User explicitly approved the prepared subnet-scoped exception. First non-admin invocation received Windows Access Denied; verified neither allow rules nor block changes existed. Hardened the operational script with explicit administrator preflight and terminating errors. Applied through an elevated Windows UAC process; result file reports success.
- Verified actual Public-profile allow rules: Docker program only, local address 192.168.10.8, remote subnet 192.168.10.0/24, TCP 7881/18080/18443 and UDP 7882.
- Verified every port 1–65535 against the actual remaining block ranges: all other TCP/UDP ports remain blocked, including TCP 3000. Network profile remains Public. Original settings: ignored `tmp/lancheck-20261019/firewall-before.json`; rollback requires an elevated invocation of `Enable-TestLanFirewall.ps1 -Rollback`.
- Post-change WSS verification again returned authenticated HTTP 101 with trusted TLS/SAN 192.168.10.8. Test API/web/PostgreSQL and the unchanged `school-crm-postgres` remain healthy.
- iPhone 15 Pro Max / Safari reachability retest requested at `http://192.168.10.8:18080/api/health`; result pending. Do not mark physical LAN, Safari CA trust or actual media verified until the device responds successfully.

### iPhone retest after firewall exception

- User reports HTTP health still does not open after the exception. Physical LAN connectivity is NOT accepted.
- Rechecked: address 192.168.10.8/24 and on-link route are present; scoped Docker exceptions and remaining blocks are as recorded. A separate Codex sandbox inbound rule is restricted to SID ending 1003; Docker processes belong to AllRISE SID ending 1000. The sandbox rule was not changed or bypassed.
- Requested iPhone Wi-Fi IP, router address and VPN state to distinguish subnet mismatch / guest isolation from host filtering. Awaiting those device values before further network changes.

### Device network screenshot — 2026-10-19

- Supplied iPhone screenshot shows SSID WiFi 57_5G, IPv4 192.168.10.4, mask 255.255.255.0, router 192.168.10.1. Server is confirmed on the same SSID with 192.168.10.8/24.
- Ping to 192.168.10.4 replies twice, but neighbor MAC A4-F8-41-B1-DA-B7 differs from screenshot private Wi-Fi MAC 12:15:40:4F:57:95. This is not proof of iPhone reachability; confirm current device address before attributing replies or changing DHCP.
- Exact program-path comparison confirms test firewall rules match the running Docker executable. No additional firewall or router changes made.
- Requested manual navigation in the Safari app to https://192.168.10.8:18443/room, current IP and VPN status; pending device response.

### HTTP sent to TLS port — reproduced and corrected

- Device screenshot shows `Client sent an HTTP request to an HTTPS server.` This confirms an HTTP response was received; it does not establish browser CA trust. User reports the same after attempting the HTTPS URL. Do not assume the user mistyped it.
- Reproduced the identical response with plain HTTP to port 18443 while verified HTTPS /room remained HTTP 200 and authenticated WSS remained 101.
- Added Caddy's standard `http_redirect` listener wrapper before `tls` on internal :443 only. The existing school routes, persisted CA and other services remain unchanged. Official reference: https://caddyserver.com/docs/caddyfile/options#listener-wrappers .
- Extended qa-lan-signaling.mjs to assert HTTP on the TLS port upgrades to exactly the same HTTPS host/port/path/query. Observed RED HTTP 400 before config fix; GREEN redirect plus trusted authenticated WSS 101 after Caddy validation/reload. No certificate checks disabled. Backup Caddyfile is in ignored tmp/lancheck-20261019/Caddyfile.before-http-upgrade.
- Device refresh requested. Safari CA trust and actual screen media remain pending.

### iPhone opened site with certificate warning

- User reports a security/certificate warning followed by successful site opening on the iPhone. Device-to-site reachability is now observed; this does NOT establish trusted TLS or real media.
- Re-exported only the public root from running test Caddy and matched it to the previously verified root. DER certificate prepared: tmp/lancheck-20261019/zaily-test-root-ca.cer. Certificate SHA256 fingerprint: F8:D1:0D:A1:85:F9:EA:7D:E4:DD:61:ED:37:4B:32:3E:7E:15:24:B4:0F:A3:83:72:A4:00:24:1C:21:11:DA:26. No private key exported.
- Explicit CA validation and authenticated WSS remain successful. User must install and enable SSL trust on the test iPhone before browser trust acceptance. This root belongs to the disposable test stack; do not deploy it school-wide or silently substitute it for the permanent installation CA.
- Apple manual trust instructions: https://support.apple.com/en-ie/102390 . Await successful device reload without warning.

### Publicly trusted domain for private LAN — approved direction

- User rejected per-student manual CA installation and approved proceeding with the discussed free PP.UA domain route. This supersedes the earlier no-domain constraint, but NOT the LAN-only access constraint. Do not distribute the temporary Caddy root school-wide.
- Live NIC.UA availability check showed `zaily-urpaq.pp.ua` available. Added that name to the browser cart; total 0.00 UAH for one year. This is not a reservation or completed registration. Browser cart handed to the user; Continue accepts the registrar agreement and requires personal account/contact/phone activation. No personal data or credentials entered; agreement not accepted by the agent.
- Target architecture: public DNS zone under school control for automated ACME DNS-01, trusted certificate for the hostname, local school DNS resolves the name to 192.168.10.8, Caddy serves HTTPS and WSS locally. No Cloudflare Tunnel, public port forwarding or publication of pupil data. A public certificate is for the hostname; opening the raw private IP will still warn.
- Prefer a local DNS override on the school router/DNS so LAN resolution does not depend on public DNS availability; verify router capability and client DNS behavior before promising offline operation. Public DNS provider API is required for automatic DNS-01 renewal; Cloudflare DNS is a possible provider, distinct from Tunnel. Server needs outbound internet for certificate issuance/renewal; routine classroom access remains LAN-local while certificate validity and local DNS permit.
- After registration: verify ownership/delegation, choose school-controlled DNS provider, configure minimal-scope DNS API credentials outside the repository, add an optional domain Caddy configuration with automated DNS-01, preserve current tested LAN route during validation, verify /room/API/WSS on iPhone without manual CA installation, then test actual media. Do not switch the live test hostname or claim a trusted public certificate before domain activation and successful ACME validation.
- Official references: https://nic.ua/en/domains/.pp.ua ; https://letsencrypt.org/docs/challenge-types/#dns-01-challenge .

### Registrar alternative — DuckDNS

- User requested another service instead of continuing NIC.UA. Opened https://www.duckdns.org/ and handed the login page to the user. Google/GitHub login choices are visible; no account or token accessed, no domain created, no DNS changed. Suggested candidate: zailyurpaq.duckdns.org; availability remains unchecked until account/domain creation.
- Official DuckDNS API supports IPv4 updates and TXT records explicitly suitable for Let's Encrypt ownership validation: https://www.duckdns.org/spec.jsp . This supports a LAN-only DNS-01 deployment without Cloudflare Tunnel. Need school-controlled DuckDNS account and privately stored token before implementation/issuance. Do not print the account token or ask for it in chat.
- Existing PP.UA order not cancelled or modified. Domain provider decision is now pending completion of DuckDNS sign-in/name creation.
