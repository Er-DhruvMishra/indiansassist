# Phase F technical contracts (binding): the Phase E open points, email invites and password reset, org erasure, the phone camera, the mobile Assist console, Linux unattended (X11) and the Wayland portal build

Status: binding for Phase F. Revision 2, 2 Nov 2026 (revision 1 the same day). Implements the Phase F plan of `docs/PLAN.md` §8 as decided by the user on 2 Nov 2026: the controller is the **mobile web console** (a touch-first, installable Assist console; no native controller app); **Linux unattended is built in full for X11 sessions** (a systemd system service on the Phase D enrollment and fleet protocol, attaching to the active user's X11 session through logind, deb and rpm, an Ansible role); **Wayland capture ships as an opt-in second Linux build** (`portal` feature: xdg-desktop-portal ScreenCast over PipeWire; view, chat and files, no control) beside the single X11 binary. The four Phase E defaults stand (no server-side fallback under `in_geo`, 7-year retention of retired token-signing keys, 2 concurrent summaries per region, the AI transcript notice in chat only).

Revision 2, 2 Nov 2026 (independent review applied; every finding checked against the code). **Blockers fixed:** (1) one org_admin could force an erasure alone by inviting and accepting a second admin, or by demoting or disabling the real ones, and could exhaust the shared rate limit to block Cancel: the approver must now have been an org_admin for at least 7 days and must not have been invited or promoted by the requester; while an erasure is open, demoting, disabling or creating an org_admin answers `409 erasure_exists`; every admin is mailed at request time as well as at approval; Cancel has no rate limit (§2.3, §5.2, §5.6, §13.2). (2) The camera security code is now a commit-before-reveal exchange over a data channel, reduced `mod 10^6` as `packages/shared/src/agent/sec.ts` does: a code built only from the SDP fingerprints lets a man in the middle choose certificates until the codes match, and 20 bits do not fill six digits (§6.5). (3) Erasure data handling: the unpeppered `login_attempt` hashes and the step-9 addresses are computed in step 1 and kept in `progress` (sealed), so a crash after the user scrub cannot lose them; queued ticket pushes and summaries are cancelled in step 2 and their sweepers skip an erasing org; `ObjectStorage` gains `list(prefix)` (F0), because it has none; presence keys are deleted by derivation from the org's ids and the certificate waits out the longest presence TTL; `piiHash` with a destroyed pepper throws `OrgErasedError` instead of hashing `"null:" + value` (§5.3, §5.4, §16.2). (4) The `org_erasing` gate has owners (`plugins/auth.ts` `authenticate` and `principalFromCookieValue`, `fleet/device-socket.ts`), applies to every authenticated request, every role can read the erasure notice, and the certificate URL is shown and mailed from the request on (§2.1, §2.4, §5.2, §5.3, §5.6). (5) Linux worker: fd 3 gets `CLOEXEC` at worker start; the privilege-drop order is bound (`setgroups` → `setgid` → `setuid` → `PR_SET_PDEATHSIG` → `getppid` check, because a uid change clears the death signal); `--console` takes runtime-dir and bus overrides so the WSL end-to-end run keeps S3; the service advertises the full X11 feature set (`multi_monitor` included) because it never connects to X and cannot count monitors, and learns the count from the worker; a Linux service advertises `elevation: 'user'` and refuses the P4 privileged mode, because `fleet/session-hooks.ts` would otherwise mark a user-level worker `admin` (§8.2, §8.5, §8.7). (6) Packages depend only on `libc6` / `glibc`, with systemd as a recommendation, so the offline T1 sandbox can install them; an offline `--deregister` never fails a removal (§8.9). (7) Wave 1 builds no shared Rust output: wave 0b copies the dev agent into `data/` and the specs set `AGENT_BIN` to the copy; the fixes stream builds into its own `CARGO_TARGET_DIR` (§1.5). (8) Camera: a presence key `ia:camsess:<sessionId>` makes `camera_busy` and revoke work across nodes; `TurnPrincipal` gains `camera:<id>` (§6.2, §16.2). (9) The manifest's `start_url` is `/app/` (inside `scope`, so browsers do not fall back to scope `/` and capture `/join`, `/room` and `/c` links), and the manifest link is injected only on `/app` pages (§7.5). (10) `Permissions-Policy` keeps `camera=()` by default and allows `camera=(self)` only on the phone page's locations, including `location = /c` (§11, W116). (11) §5.4 corrected: `device_group` names keep the unique index (`Erased group <id 8>`), `elevation_handover` has no `error` column, `device.group_name` is scrubbed, and `tamper.acknowledged.note` is listed among the free text the chain keeps. (12) Ownership gaps closed: `userSchema.inviteMailedAt` and `toUser` (F0, with the column), `agentInput.ts`, `agentConsoleController.ts`, `AgentControls.tsx` and `AccountPage.tsx` (mobile), the Linux pre-login refusal in `fleet/device-sessions.ts` (linux-p4), the emulator specs under their own Playwright config and script, the residency print measured with the erasure block held to a fixed 12 mm print budget that F0's placeholder occupies and erasure's test enforces, and the SSO notice mails counted against the same hourly cap in presence (§1.4, §3.2, §4.3, §15.9). **Rejected in part:** the review's "S3 multipart uploads are left behind" does not hold: `recording.upload_id` is the api's own random upload id (`routes/recordings.ts`), parts are ordinary objects under the recording's storage key, and the S3 driver uses a single `PutObjectCommand` (`adapters/storage-s3.ts`), so `list(prefix)` and `delete` remove everything and no abort call is needed; a presence-wide scan is not added either, because every org-bearing presence key is either derivable from ids in the database (deleted in step 2) or expires within 2,100 s, which step 8 waits out (§5.3). The E note "e2e:p3 ignores E2E_DATA_DIR" was already closed by F0 in revision 1 (§3.5) and stays.

**User decisions folded into revision 2 (2 Nov 2026).** The user's guiding rule is "the final product is easy to use, error and lag free, maximum functionalities available"; every remaining judgement call in this contract was re-decided by it. **Open questions resolved:** (1) erasure keeps technicians' display names and typed reasons in the chain (default kept); (2) dual control stays, but an org with exactly one eligible org_admin may erase alone, with a 14-day cooling-off, a confirmation link opened within 24 h, and re-authentication within 15 minutes; every revision-2 safeguard still applies (§5.1, §5.2f, W124); (3) 7 days to approve, 7 days of cooling-off, 15-minute re-authentication (kept); (4) no legal hold (kept, now W123); (5) backups age out under the operator's retention, stated in the certificate (kept); (6) **the phone camera is recorded** whenever the session is recorded under the org's policy, as separate camera recordings through the same two paths (the A.2 server recorder, the console recorder), and the phone's consent screen says so first (§6.5a, W125, reversing revision 1's W104 position); (7) **a locked Linux X11 session can be controlled** (typing the password into the locker through XTEST) under the same consent and policy as an unlocked one; the greeter stays out (§8.4e, W126); (8) **one Linux download**: the archive holds the X11 binary and the portal binary, and the X11 binary hands over to its sibling on a Wayland session when libpipewire loads; the join page offers a single Linux button (§9.5, W127). **Ease of use:** the Android app gains **Give help** (the mobile console in a Custom Tab; stream mobile; §7.8, W128); the native Windows and Linux agents draw the camera QR in their chat (stream linux-p4, wave 2; §6.1, W104 revised); touch control of P2 sessions is now in scope through the replayer's existing capture (stream mobile; §7.1, W107 revised). **New stream apple** (§17): the macOS portable agent, macOS unattended (launchd daemon and LaunchAgent, PKG, PPPC template) and the iOS app (ReplayKit share, view only, plus Give help), built by a separate session on the user's Mac, promoted from E §8 and updated to the code as it stands (W129).

**Phase A (`docs/specs/phase-a-contracts.md`, "A"), A.2 (`phase-a2-recorder.md`), B, C, D (revision 6) and E (`phase-e-contracts.md` revision 4, "E") stay binding.** This document only adds to them; every change to existing shared code, the database or an earlier contract is indexed in §16.2 as file, symbol, old, new. If something here is wrong, amend this file first, then the code. **Where an earlier contract and the code disagree, the code was read on 2 Nov 2026 and wins; each such case is named where it matters** (for example E §10 says `infra/.env.example` documents every variable, but `FLEET_DATA_KEY`, `MAIL_DRIVER`, `SMTP_URL`, `MAIL_FROM` and the `VAULT_*` keys are missing from it, §3.1).

**Streams.** One small **F0 foundation** stream builds first and merges (§1.4). Then five streams build in parallel, TypeScript-heavy, without talking to each other: **fixes**, **mail**, **erasure**, **camera**, **mobile**. Then **linux-p4** and **wayland** follow, one at a time, because two Rust builds at once exhaust the build machine's memory (§1.5). An eighth stream, **apple** (§17), builds on the user's Mac in a separate session, in parallel with waves 1–3, and reaches this repository only by git.

Vocabulary (inverted, as in every earlier contract): **Desk** = the computer or person being helped. **Assist** = the technician console (`apps/web`). "Phone" (camera stream) = a mobile browser that joins a live session only as a camera. "Erasure" = the destruction of one org's personal data in its region by deleting rows, scrubbing columns and destroying `org.audit_pepper` (A §4.2). "Service" (linux-p4) = `ia-service` running as a systemd system unit. "Worker" = `ia-desktop`, the per-session process the service launches in the user's X11 session.

Conventions: everything in the A to E conventions tables applies (camelCase wire keys, `ts` integer ms, ISO 8601 elsewhere, lower snake_case enums, base64url without padding, lower-case hex, PII in the chain only as `piiHash(org, value)`). New ones:

| Convention | Rule |
|---|---|
| Section references | "F §3" = this document; "E §7.7", "D §4.2", "C §10", "A §5.3" = the earlier contracts |
| Module names | shared: `packages/shared/src/enums-f.ts` (re-exported by `enums.ts`, the `enums-e.ts` pattern), `packages/shared/src/audit/actions-f.ts`, `packages/shared/src/schemas/rest-{mail,erasure,camera}.ts`, `packages/shared/src/schemas/signal-camera.ts`, `packages/shared/src/erasure/certificate.ts`, `packages/shared/src/touch/*`; api: `apps/api/src/{mail,erasure,camera}/*`; db: `packages/db/src/schema/{mail,erasure}.ts`, migration `0009_phase_f`; agent: new crate `ia-capture-portal`; packaging: `packaging/linux/*` |
| Secrets in mail | a token that a mail carries (password reset, invite) is 32 CSPRNG bytes, base64url, stored only as `sha256Hex(token)`, single use, carried in a URL **fragment** (`#t=` / `#i=`, so it never reaches a server log or a `Referer`), and never logged, chained or returned twice |
| No account enumeration | every public auth route answers an unknown email exactly as it answers a known one: same status, same body, work done after the reply (§4.3) |
| Erasure is region-local | an erasure acts only on the org's region database and the region bucket prefix `<region>/<orgId>/`; nothing is replicated, so nothing outside the region needs it (A T1) |
| Fakes, not networks | no automated test sends a real email, calls a real IdP or ticketing service, installs a package on the build machine or the main WSL distro, or opens the real desktop session (§1.6) |
| Library additions | every new npm package and Rust crate is listed with its licence in §10 and in `docs/LICENSE-REGISTER.md` in the same change; `node scripts/license-check.mjs` stays green; no AGPL code (decision 15.5). Phase F adds **no npm package** |

---

## 1. Scope, principles and architecture decisions

### 1.1 In scope (Phase F)

| # | Deliverable | Source | Stream |
|---|---|---|---|
| 1 | Shared names and schemas, migration `0009_phase_f`, route, sweeper, signal and console hooks, licence rows, env keys, every `infra/` edit | PLAN §8 | F0 |
| 2 | Compose passes `FLEET_DATA_KEY` (and every other api key it was missing) to the api; the fleet key gets a previous-keys list with lazy re-sealing (closes E W89); the residency print gets measured headroom; the Jira, ServiceNow and Freshdesk request shapes and the Zoho Desk data-centre hosts are verified against vendor documentation with recorded sources (Zoho rows ship only when verified); the C §10 D5 **Keep** control in the Desk UI on Windows and Linux, shown read-only in the console | E §15.8, W89, C D5 | fixes |
| 3 | Invites by email and password reset over the existing `Mailer`; single-use hashed tokens, no account enumeration, rate limits; SSO-required orgs offer no reset except to break-glass administrators | B §14.1, E W76 | mail |
| 4 | Org erasure by `audit_pepper` destruction: requested by one org_admin, approved by a second, a cooling-off period, irreversible, region-local; personal data deleted or scrubbed, the pepper destroyed, the chain still verifying; a signed erasure certificate; the residency report shows `erasure.available: true` | A §4.2, §5.3, E W75 | erasure |
| 5 | The phone as a support camera in P1, P3 and P4 sessions: a QR code or short link opens the phone browser's rear camera after explicit consent; the Assist sees it live, can freeze and snapshot; the camera is recorded whenever the session is recorded; the chain records it | PRD 12.8, PRD 4 row "Camera sharing", C §1.4, E W87 | camera |
| 6 | The touch-first Assist console: installable (manifest and an app-shell-only service worker), touch mapped to pointer for P1, P2, P3/P4 and Android host Desks, an on-screen keyboard with special keys, phone and tablet layouts; **Give help** in the Android app (the console in a Custom Tab) | PRD 5 "iOS ... an iPhone can be the Assist", "Android ... web console", decision 15.6 | mobile |
| 7 | Linux unattended: the `ia-service` Linux half as a systemd system service on the D enrollment and fleet protocol, attaching to the active user's X11 session through logind, the `ia-desktop` worker on Linux, deb and rpm, an Ansible role, the fleet console and installer download changes | PRD 5 "Linux ... systemd service; deb and rpm, Ansible", D W36, E W82 | linux-p4 |
| 8 | The `portal` binary: xdg-desktop-portal ScreenCast over PipeWire, view only, shipped **inside the single Linux download** beside the X11 binary, which hands over to it on a Wayland session | PRD 5 Linux, E §7.4, W77 | wayland |
| 9 | The macOS portable agent (P3), macOS unattended (P4: launchd daemon and LaunchAgent, PKG, MDM PPPC template) and the iOS app (ReplayKit share, view only; Give help), promoted from E §8 | PRD 5 macOS and iOS, PRD 14, E §8, W83, W84 | apple (§17) |

### 1.2 Out of scope (each in §16)

| Item | Note |
|---|---|
| Linux pre-login (greeter) access, Linux Wayland unattended screen, Linux elevation, Linux arm64 | W108, W115, E W81 |
| uinput input on any Linux build | W114 (E W78 stands) |
| Signed deb/rpm, an apt or dnf repository, Ansible Galaxy publication | W111 |
| A native controller UI (the phone apps open the mobile web console instead) | W106 |
| Storing camera snapshots on the server (they are saved in the technician's browser and chained by hash) | W104 |
| Per-data-subject erasure (one user, one Desk); a legal-hold mechanism | W102, W123 |
| The macOS login window and pre-login access; iOS control of any kind (Apple allows none) | §17, W129 |
| A run against a real Linux window manager and session bus; the manual checks on a disposable machine; the 2,000-device load run | PLAN §8 "Still outside this machine" |

### 1.3 Principles

| # | Principle | Consequence |
|---|---|---|
| F1 | **Build on the seams that exist.** The `Mailer` (`apps/api/src/mail/mailer.ts`), the invite token on `user.invite_token_hash`, `Presence.consume`, the signaling hub's sides and `peer` routing, the `ia-platform` service traits, the `ia-session0` blob and frames, `AgentDist` / `InstallerDist`, the E slot pattern and `selfdel::plan(.., kept)` are extended, never replaced | §16.2 lists every touched symbol |
| F2 | **Irreversible means two people and time.** Erasure needs a second org_admin and a cooling-off period, and any admin can cancel until it starts; an org with a single eligible admin replaces the second person with a mailed confirmation and twice the time | §5 |
| F3 | **The chain is never rewritten.** Erasure deletes and scrubs mutable rows and destroys the pepper; `audit_entry` and `audit_checkpoint` stay byte for byte, so the chain verifies after erasure (A §5.3) | §5.5 |
| F4 | **Consent stays with the person.** The phone camera starts only after a tap on the phone; Keep is set only by physical input on the Desk; the console can see both, set neither | §3.4, §6.3 |
| F5 | **A root service never captures.** The Linux service runs as root and never connects to an X server; capture and input run in the worker, as the session's user | §8.4 |
| F6 | **Honest capabilities.** Each Linux build and session type advertises exactly what it has; the console greys the rest in words | §8.7, §9.4 |
| F7 | **The service worker caches the shell, never data.** No API response, session data, signal frame or download is ever cached | §7.6 |
| F8 | **Nothing on the build machine changes.** Tests install nothing on Windows or the main WSL distro; package installs run only in a throwaway environment the harness owns, or by hand on a disposable machine | §1.6, §8.12 |

### 1.4 Streams, ownership and the seams between them (binding)

F0 lands first and contains only names, shapes, plumbing and empty hooks, no behaviour. **After F0 merges, every file has exactly one owner**; a stream edits only the files in its row. A stream that finds a foundation shape wrong amends this file and the foundation file in one change; a stream that needs a shared file F0 did not stub raises it here first.

| Stream | Owns (writes) | Reads from other streams only through |
|---|---|---|
| **F0 foundation** (first) | `packages/shared`: `enums-f.ts` (new), `audit/actions-f.ts` (new), `schemas/rest-{mail,erasure,camera}.ts` (new), `schemas/signal-camera.ts` (new), `erasure/certificate.ts` (**schemas only**; `signErasureCertificate` / `verifyErasureCertificate` throw `notBuilt` until erasure fills them), `touch/gestures.ts` (**types only**; mobile fills it), and the additive edits of §16.2 to `enums.ts`, `enums-p3.ts`, `errors.ts`, `audit/actions.ts`, `audit/actions-p3.ts`, `agent/control.ts`, `agent/download.ts`, `fleet/device.ts`, `fleet/installer.ts`, `schemas/signal.ts`, `schemas/rest-core.ts`, `schemas/rest-residency.ts`, `enterprise/integrations.ts` (`INTEGRATION_VERIFICATION` with every row `verified: false`), `index.ts`; `packages/db`: `schema/{mail,erasure}.ts`, the column and enum edits of §13.2, migration `0009_phase_f` with its snapshot and journal entry, the repo functions of §13.2a, the `insertAuditEntry` erased-org guard; `apps/api`: the env keys and their config groups in `config.ts` (§11), `context.ts` additions, `app.ts` (`PHASE_F_ROUTE_PLUGINS = [mailRoutes, erasureRoutes, cameraRoutes]`, each a stub plugin that registers nothing in `mail/routes.ts`, `erasure/routes.ts`, `camera/routes.ts`), `sweeper.ts` (passes `sweepMailTokens` from `mail/sweep.ts` and `sweepErasures` from `erasure/sweep.ts`, no-ops), `signal/hub.ts` and `signal/conn.ts` (the `camera` side, `CAMERA_CLIENT_TYPES` dispatch to stub handlers in `signal/camera.ts` that answer `error forbidden`, `Live.camera: null`), `signal/relay.ts` (the `peer: 'camera'` branch calling `routeCameraWebrtc` from `signal/camera.ts`), `services/residency.ts` (the `mail` flow `dataSent` text only, §4.1), `lib/logger.ts` (§14 redact paths), `lib/metrics.ts` (§12 series, zero-initialised); `apps/web`: `auth/permissions.ts` (§2.1 names), `App.tsx` routes (`/reset`, `/c`, `/c/:code`, `/app/settings/erasure`) and `assist/AppShell.tsx` nav entry, each pointing at a placeholder page in its stream's directory, `assist/console/PhaseFSlots.tsx` (new) with `<CameraSlot>` placed in `LiveConsole.tsx` and `agent/AgentConsole.tsx`, `<DeskKeepSlot>` in `agent/AgentConsole.tsx`, `<ErasureBannerSlot>` in `AppShell.tsx`, `<ResidencyErasureSlot>` in `ResidencyPage.tsx` (replacing the inline erasure lines), and the `messageAccessory` prop of `components/ChatPanel.tsx` wired in `desk/SharingView.tsx` to `<CameraLinkAccessory>`; `apps/web/playwright.config.ts` (`testMatch` widened, §15.9; the P3 suite honours `E2E_DATA_DIR`); `apps/web/e2e/emulator-chrome.ts` (new: the shared Android-emulator Chrome harness with its lock, §15.9) and `apps/web/e2e/emulator.config.ts` (new: `testMatch: /-emulator\.spec\.ts$/`, script `e2e:emulator`); and, added in revision 2: `ObjectStorage.list(prefix)` in `apps/api/src/adapters/{storage,storage-fs,storage-s3}.ts` (§5.3); the erased-pepper guards in `packages/shared/src/canonical.ts` (`pepperedHash` throws on a pepper that is not 64 hex) and `apps/api/src/lib/audit.ts` (`piiHash` throws `OrgErasedError` when `auditPepper` is null); the `org_erasing` gate in `apps/api/src/plugins/auth.ts` (`principalFromCookieValue` / `authenticate`) and the device hello refusal in `apps/api/src/fleet/device-socket.ts` (§5.3 step 1); the call `await assertNoOpenErasure(ctx, org, change)` in `routes/users.ts` invite, role and status handlers, importing a stub from `apps/api/src/erasure/guard.ts` that the erasure stream fills (§5.2e); `userSchema.inviteMailedAt` (`schemas/rest-core.ts`) and its `toUser` mapping (`lib/mappers.ts`); and, for the user decisions: the camera-recording names (`recorder.camera` in `schemas/signal-recorder.ts`, `recording.source` / `camera_id` in the migration, the optional `source` in the A.2 chain schemas, the `peer: 'recorder'` branch from the camera side in `signal/relay.ts` calling `routeCameraRecorderWebrtc` in `signal/camera.ts`); the **apple hooks** of §17.7 (the stub crates `agent/crates/ia-capture-mac` and `ia-input-mac` as workspace members with empty `cfg(target_os = "macos")` modules, `agent/crates/ia-platform/src/macos/mod.rs`, `ia-service/src/macos/mod.rs` with the `macos-service` feature declared, and the marked `cfg(target_os = "macos")` blocks of §17.7 in `ia-agent`, `ia-core`, `ia-ui` and `ia-desktop`), the shared names of §17.8, and `apps/ios/` and `packaging/macos/` as empty directories (a `.gitkeep` each); every `infra/` file (§11, §16.2) and `scripts/infra/*.mjs` checks; `scripts/smoke-f.mjs` (the runner, `F_FLOWS = ['fixes', 'mail', 'erasure', 'camera']`); the licence-register rows of §10 as **"planned, Phase F <stream>"**; `package.json` scripts `smoke:f`, `e2e:f`, `e2e:mobile`, `e2e:emulator`, `e2e:p4:linux`, `linux:pkg`, `linux:throwaway` (pointing at files their streams create) | n/a |
| **fixes** | `apps/api/src/fleet/common.ts` (`macKeys`, lazy re-seal); `scripts/reseal-org-secrets.mjs` (device MACs added); `packages/shared/src/enterprise/integrations.ts` **rows** of `ZOHO_DATA_CENTERS` and `INTEGRATION_VERIFICATION`; `apps/api/src/integrations/adapters/*` and `apps/api/test/fake-ticketing.ts` (only where a verified shape differs); `apps/web/src/assist/integrations/IntegrationsPage.tsx` (the unverified note); `apps/web/src/assist/ResidencyPage.tsx` (print only); `apps/web/e2e/enterprise-residency.spec.ts`; the Keep work in `agent/crates/ia-ui/src/*`, `agent/crates/ia-agent/src/serve.rs` (exit path), `agent/crates/ia-agent/src/serve/selfdel.rs`, `agent/crates/ia-platform/src/linux/selfdel.rs`, `agent/crates/ia-platform/src/selfdelete.rs`; `apps/web/src/assist/console/agent/KeepState.tsx` (behind `<DeskKeepSlot>`); `scripts/smoke/flow-f-fixes.mjs` | nothing |
| **mail** | `apps/api/src/mail/*` (including `mailer.ts`, `templates.ts`, `mailRoutes` with the reset and options routes, `sweepMailTokens`), the edits to `routes/users.ts` (invite mail, resend; the F0 erasure-guard call is not touched; `routes/auth.ts` is not edited); `apps/web/src/pages/{LoginPage,PasswordResetPage}.tsx`, `apps/web/src/assist/UsersPage.tsx`; `apps/api/test/fake-smtp.ts`, `scripts/smoke/fake-smtp.mjs`, `scripts/smoke/flow-f-mail.mjs`; `apps/web/e2e/f-mail.spec.ts` | nothing |
| **erasure** | `apps/api/src/erasure/*` (`erasureRoutes`, `sweepErasures`, the executor, `guard.ts`); the "skip an org with `erasing_at` set" line in `apps/api/src/integrations/sweep.ts` and `apps/api/src/ai/worker.ts` (§5.3 step 2); `apps/api/src/services/residency.ts` erasure block and `retention.piiInChain` text; the behaviour of `packages/shared/src/erasure/certificate.ts`; `apps/web/src/assist/erasure/*` (`ErasurePage`, `ErasureBanner`, `ResidencyErasure`); `scripts/verify-erasure.mjs`; `scripts/smoke/flow-f-erasure.mjs`; `apps/web/e2e/f-erasure.spec.ts` | the `org_erasure` and `password_reset` tables through §13.2a only |
| **camera** | `apps/api/src/camera/*` (`cameraRoutes`), `apps/api/src/signal/camera.ts`; the camera additions to `services/recorder/**` (Go, gate `pnpm recorder:test`) and to `apps/api/src/routes/internal-recordings.ts` (the `source: 'camera'` meta); the console's camera recording in `apps/web/src/camera/*`; `apps/web/src/camera/*` (the phone page `CameraJoinPage`, `CameraPanel` behind `<CameraSlot>`, `CameraLinkAccessory`); `scripts/smoke/flow-f-camera.mjs`; `apps/web/e2e/f-camera.spec.ts`, `apps/web/e2e/camera-p3.spec.ts`, `apps/web/e2e/camera-emulator.spec.ts` | nothing |
| **mobile** | `packages/shared/src/touch/gestures.ts` behaviour; `apps/web/src/assist/touch/*` (new); after F0: `apps/web/src/assist/console/{ConsolePage,LiveConsole,RemoteView}.tsx`, `apps/web/src/assist/console/agent/{AgentConsole,AgentScreen,InputOverlay,AgentControls}.tsx`, `apps/web/src/assist/console/agent/{agentInput,agentConsoleController}.ts`, `apps/web/src/assist/AccountPage.tsx` (the Install button), `apps/web/src/assist/AppShell.tsx` (layout), `apps/web/src/main.tsx` (service-worker registration), `apps/web/index.html`, `apps/web/vite.config.ts` (the `sw.js` build step), `apps/web/public/{manifest.webmanifest,icons/*}`, `apps/web/src/sw.ts` (new); `apps/web/src/replayer/**` and `assist/console/mirror/{MirrorConsole.tsx,ReplayerHost.tsx,InputModeToggle.tsx}` (P2 touch, §7.2); `apps/android/**` for **Give help** and tappable camera links in the host's chat (§7.8; the Phase C host code is otherwise untouched); `apps/web/e2e/{mobile.config.ts,mobile.spec.ts,mobile-emulator.spec.ts}` | nothing |
| **linux-p4** | `agent/crates/ia-service/**` (the Linux half), `agent/crates/ia-session0/src/unix.rs` (new) and the Linux branch of `ia-session0`, `agent/crates/ia-desktop/**` (the Linux build), the Linux half of `agent/crates/ia-platform/src/service.rs` impls in `src/linux/service.rs` (new); `packaging/linux/**`; the Linux branch of `apps/api/src/routes/download.ts` installer routes and `services/installer-dist.ts`; `apps/api/src/fleet/routes-devices.ts` (enrollment `platform: 'linux'`), `apps/api/src/fleet/device-sessions.ts` (`prelogin_unsupported`, where the D §6.2 verdict is turned into errors), `apps/api/src/fleet/session-hooks.ts` (privileged mode refused for Linux devices, §8.7); `apps/web/src/assist/tokens/EnrollDeployDialog.tsx`, `apps/web/src/lib/fleetApi.ts`, `apps/web/src/assist/fleet/{DeviceDetailPage.tsx,fleetText.ts}`; `agent/scripts/{logind-fake.sh,service-e2e.sh,pkg-sandbox-test.sh,throwaway-wsl.ps1}`; the camera-link QR in the chat panel of `agent/crates/ia-ui` (Windows and Linux, §6.1); `apps/web/e2e/{run-p4-linux.mjs,p4-linux.config.ts,package4-linux.spec.ts}` | nothing |
| **wayland** | `agent/crates/ia-capture-portal/**` (new); the `portal` arms in `agent/crates/ia-agent/src/{pump,desk}.rs` and `Cargo.toml` features; `agent/crates/ia-ui` `wayland` feature wiring; `ia-core/src/types.rs` `LINUX_PORTAL_FEATURES`; the two-binary archive in `apps/api/src/services/{agent-dist,linux-archive}.ts` and `routes/download.ts` (§9.5); the Wayland hand-over in `ia-agent` (`desk.rs`, `main.rs`) and the companion self-delete in `ia-platform/src/linux/selfdel.rs` (after linux-p4 merged); `apps/web/src/desk/{JoinP3.tsx,agentDownload.ts}`; `agent/scripts/portal-test.sh`; the fourth case of `apps/web/e2e/package3-linux.spec.ts` and `linux-agent-harness.ts` | nothing |
| **apple** (on the Mac, §17) | `agent/crates/ia-capture-mac/**`, `agent/crates/ia-input-mac/**`, `agent/crates/ia-platform/src/macos/**`, `agent/crates/ia-service/src/macos/**`; **inside other files only** the `cfg(target_os = "macos")` blocks F0 marks `// apple-owned: begin` … `// apple-owned: end` and the `[target.'cfg(target_os = "macos")'.dependencies]` tables of crate manifests; `packaging/macos/**`; `apps/ios/**`; `agent/scripts/macos-*.sh`; its tests and fixtures under those paths | nothing; every other shared need is raised in this file and landed by F0 (or, after F0, by the file's owner) — the apple session never edits a file or block another stream owns |

**`Cargo.lock`** is the one file several Rust streams change (fixes, linux-p4, wayland here; apple on the Mac). Each stream's change must be **additive**: it may add packages but must not move an existing package's version; the coordinator merges by keeping the union and checks with `cargo tree --locked` on both hosts that no existing version moved. Ownership of a shared Rust file across the two Rust streams is sequential, not parallel: linux-p4 finishes and merges before wayland starts (§1.5), so `ia-agent/Cargo.toml` and `ia-core/src/types.rs` each have one writer at a time.

### 1.5 Waves, machine facts, ports and data directories (binding)

| Wave | Streams | Rule |
|---|---|---|
| 0 | F0 | merges before anything else; the F0 gates of §15.1 green |
| 0b | coordinator | builds the Windows dev agent once (`pnpm agent:build:dev`) and **copies** `agent/target/release/IndiansAssist.exe` to `data/agent-bin/IndiansAssist.exe`; the camera and mobile P3 cases run with `AGENT_BIN=<that copy>` (`resolveAgentBinary` in `apps/web/e2e/agent-harness.ts` honours it) and never through `pnpm e2e:p3`, whose script runs `pnpm agent:build:dev` first (`package.json`); they invoke Playwright with `E2E_P3=1` and `AGENT_DEV_STUB` pointing at the copy directly |
| 1 | fixes, mail, erasure, camera, mobile (parallel) | **fixes is the only stream in wave 1 that builds Rust** (the Keep work), and it builds into its own `CARGO_TARGET_DIR` (`%LOCALAPPDATA%\ia-agent-target-fixes` on Windows; `$HOME/.cache/ia-agent-target-fixes` in WSL), so it never rewrites `agent/target/release/IndiansAssist.exe`, which Windows locks while a test runs it; no other wave-1 stream runs `cargo` or `agent:build:dev`. Android-emulator runs are serialised by the lock in `apps/web/e2e/emulator-chrome.ts` (`data/.emulator.lock`; a second runner waits up to 30 minutes, then reports "not run: emulator busy") |
| 2 | linux-p4 | after wave 1 merged; the only Rust build while it runs |
| 3 | wayland | after linux-p4 merged |
| Mac | apple | on the user's Mac, any time after F0 merged and was pushed; it uses the Mac's memory, so it never competes with this machine's single Rust build; it pulls by git and pushes a branch the coordinator integrates |

Machine facts the streams must respect (verified 2 Nov 2026): ports **4000, 4100 and 4105 are taken** and are never used by a Phase F suite; no Docker, no Postgres (PGlite only); WSL 2 Ubuntu 26.04.1 LTS with systemd as PID 1, `systemd-analyze` 259, `dpkg-deb` 1.23.7, `bwrap`, `dbus-daemon`, `Xvfb`, `xdotool`, unprivileged user namespaces available. **Corrected by F0 (2 Nov 2026, the user's install verified with `dpkg-query`):** the one-time WSL system packages of §8.12 and §9.6 **are installed**: `sway swaybg xdg-desktop-portal xdg-desktop-portal-wlr pipewire pipewire-bin wireplumber libpipewire-0.3-dev libspa-0.2-dev clang libclang-dev rpm ansible-core ansible-lint`; the user-level build tools **`cargo-deb` and `cargo-generate-rpm` are not yet installed** (§8.9, §8.12: until they are, the package-build gates are reported not met); the Android emulator `Pixel7_API35` (image `google_apis` x86_64, so Chrome is present; back camera `emulated`, no front camera) driven by `IA_EMULATOR=1`.

| Stream | api port (`E2E_API_PORT`) | web port (`E2E_WEB_PORT`) | data dir (`E2E_DATA_DIR`) | smoke api | other |
|---|---|---|---|---|---|
| F0 | 4130 | 5290 | `./data/e2e-f0` | 4131 | |
| fixes | 4135 | 5295 | `./data/e2e-fixes` | 4136 | |
| mail | 4140 | 5300 | `./data/e2e-mail` | 4141 | fake SMTP `127.0.0.1:2526` (`E2E_SMTP_PORT`) |
| erasure | 4145 | 5305 | `./data/e2e-erasure` | 4146 | |
| camera | 4150 | 5310 | `./data/e2e-camera` | 4151 | emulator harness api 4310, web 5315 |
| mobile | 4155 | 5320 (`vite preview`) | `./data/e2e-mobile` | n/a | emulator harness api 4320, web 5325 |
| linux-p4 | 4160 | 5330 | `./data/e2e-linux-p4` | n/a | harness Xvfb `:97`, api bound to `0.0.0.0` |
| wayland | 4115 | 5285 | `./data/e2e-linux` | n/a | the E `e2e:p3:linux` defaults (run after linux-p4, so no clash) |

Every suite sets `METRICS_PORT=0`. A suite refuses to start when its api port is 4000, 4100 or 4105 (the E `p3-linux.config.ts` rule, extended to every Phase F config).

### 1.6 Standing safety rules (binding for every stream's tests)

| # | Rule |
|---|---|
| S1 | Automated tests use **only read-only playbooks** (they read, list or echo; they never write outside a temporary directory, change settings, install or delete) |
| S2 | Every automated Rust agent runs with `--synthetic-capture` (unless the test is an X11 or portal capture test against a harness-owned display) and **`--no-self-delete`**; `agent/scripts/e2e-agent.sh` and the new `service-e2e.sh` refuse to start an agent without `--no-self-delete` |
| S3 | Linux tests use only a harness-owned display (Xvfb `-noreset` on a display number the harness owns, or the harness's headless sway), a temporary `XDG_*` root, `env -u WAYLAND_DISPLAY`, and either **no session bus** (`DBUS_SESSION_BUS_ADDRESS` naming a path that does not exist) or a **private bus the harness started** (only the logind fake of §8.12 and the portal stack of §9.6 need one); never the WSLg desktop (`:0`, `wayland-0`) and never the user's session or system bus |
| S4 | Nothing is installed or uninstalled on the development machine or the main WSL distro by a test: no MSI, no deb, no rpm, no `pip`, no `cargo install`, no `apt`. Package installs run only in the throwaway environments of §8.12 |
| S5 | No test triggers a real elevation prompt (UAC, `pkexec`, `sudo`) |
| S6 | Test email addresses are synthetic (`@example.test`, `@example.com`, `@e2e.example.com`); no real person's address appears in this document, a fixture, a log assertion or any request. No request to a vendor, crates.io or a documentation site carries personal data |
| S7 | Keep and self-delete are applied only to temporary directories in tests (§3.4); the built binary is never deleted or copied by automation |
| S8 | The fake SMTP server binds `127.0.0.1` only and never relays |
| S9 | The apple stream's own rules (§17.5) apply on the Mac: synthetic capture, no TCC database edits, no system-wide installs, PKG installs only in a throwaway macOS VM or by hand |

---

## 2. Cross-cutting rules

### 2.1 RBAC additions (A §2.3 matrix extended)

| Capability | technician | senior_technician | org_admin | auditor | observer |
|---|---|---|---|---|---|
| Invite by email, resend an invite | no | no | yes | no | no |
| Erasure status read | the notice only (`state`, `coolingOffUntil`, `certificateUrl`) | the notice only | yes | yes | the notice only |
| Erasure request, cancel | no | no | yes | no | no |
| Erasure approve | no | no | yes, and not the requester | no | no |
| Camera link create or revoke, snapshot record | own session (the session's Assist) | the session's Assist | the session's Assist | no | no |
| Linux installer download | no | no | yes (the D `requireFleetRole(p, 'admin')` rule) | no | no |

"The session's Assist" is the existing `requireSessionAssist(p, session)` rule (`apps/api/src/services/scope.ts`) after `scopedSession`. Cross-org ids are `404 not_found`, same-org outside scope `403 forbidden` (A §2.3). Web capability names (`apps/web/src/auth/permissions.ts`, additive): `users.invite_mail` (org_admin), `erasure.read` (org_admin, auditor), `erasure.admin` (org_admin), `camera.use` (technician, senior_technician, org_admin).

### 2.2 Audit conventions for Phase F

Every new action is in `audit/actions-f.ts` as `F_AUDIT_ACTIONS` / `F_CHAIN_SCHEMAS` (strict, strings sanitised before hashing) / `F_ACTION_ACTORS` (one actor each), joined into `AUDIT_ACTIONS` and `auditDataSchema` by `actions.ts`, exactly the E pattern. Emails appear only as `emailHash`; no token, reset link, mail body, camera frame, snapshot bytes or erasure reason is ever in a chain `data` object. The table is §13.3.

### 2.3 Rate limits (A §6.12 style; per IP unless stated)

| Route | Limit |
|---|---|
| `POST /auth/password-reset/request` | 5 / minute per IP; at most 3 mails / hour per email (excess dropped silently, the reply is unchanged) |
| `POST /auth/password-reset/confirm` | 10 / minute per IP |
| `POST /users/:id/invite/resend` | 5 / hour per target user, 30 / hour per org |
| Erasure request, approve | 5 / hour per org, a separate bucket each (`erasure-request:<orgId>`, `erasure-approve:<orgId>`) |
| Erasure cancel | **no limit** (an attacker must never be able to exhaust a bucket and block a Cancel; the route still needs an org_admin session and the CSRF header) |
| `GET /erasures/:id/certificate`, `.../chain-digest` | 30 / minute per IP |
| `POST /sessions/:id/camera-links` | 6 / minute per user |
| `camera.hello` on `/signal` | 20 / minute per IP (wrong codes count) |
| `POST .../camera/:cameraId/snapshots` | 10 / minute per session |

### 2.4 New REST error codes (`packages/shared/src/errors.ts`, additive)

| Code | HTTP | Raised by |
|---|---|---|
| `reset_invalid` | 400 | a reset token that is unknown, used, expired or superseded (one code for all four, §4.3) |
| `erasure_exists` | 409 | a request while another erasure of the org is `pending_approval`, `cooling_off` or `executing`; and, while one is open, `PATCH /users/:id/role` away from `org_admin`, `PATCH /users/:id/status` disabling an org_admin, or `POST /users/invite` / a role change creating an org_admin (§5.2e) |
| `erasure_second_admin` | 409 | a request in an org with fewer than two eligible org_admins, or an approval by an admin who is not eligible (§5.2b: the requester, an admin of fewer than 7 days, or one the requester invited or promoted) |
| `erasure_confirm_mismatch` | 400 | `confirmSlug` differs from the org's slug |
| `erasure_confirm_invalid` | 400 | a solo-erasure confirmation token that is unknown, used or older than 24 h (§5.2f) |
| `camera_unrecordable` | 409 | a camera link when the session is recorded by the server recorder and the joined recorder does not advertise camera support (§6.5a) |
| `erasure_not_cancellable` | 409 | cancel after the erasure started executing |
| `org_erasing` | 409 | **every** authenticated request (read or write), login, and socket hello (`/signal` and `/signal/device`) for an org whose erasure is `executing` (§5.3 step 1); `erasure_exists` additionally answers a demotion, a disabling or a new org_admin while an erasure is open (§5.2e) |
| `camera_busy` | 409 | a new camera link while the session has a pending link or a connected camera (`LIMITS.cameraPerSession` = 1) |
| `camera_unsupported` | 409 | a camera link for a `p2_extension` session (PRD 4: "No") |
| `prelogin_unsupported` | 409 | `POST /devices/:id/sessions` to a `linux` device whose interactive state is `none` (§8.6) |

`reauth_required` (A), `bad_state`, `forbidden`, `not_found`, `rate_limited`, `validation_failed` keep their meaning. `SIGNAL_ERROR_CODES` gains `camera_link_invalid` and `camera_busy`; `SESSION_END_REASONS` gains `org_erased`.

---

## 3. The Phase E open points (stream fixes)

### 3.1 Compose and the fleet key (binding; closes E W89 and the E §15.8 compose item)

Verified against the code: `infra/docker-compose.yml`'s `api` service never sets `FLEET_DATA_KEY`, `MAIL_DRIVER`, `SMTP_URL`, `MAIL_FROM`, `VAULT_ADDR`, `VAULT_ROLE_ID`, `VAULT_SECRET_ID`, `AGENT_DIST_DIR`, `AGENT_MSI_DIST_DIR`, `AGENT_MIN_VERSION`, `AGENT_ANDROID_APP_URL`, `DEVICE_HELLO_RATE` or `WAKE_CONFIRM_SEC`, so a production api boots and fails (`FLEET_DATA_KEY is required in production`, `config.ts`) or silently runs the defaults; and `infra/.env.example` documents none of `FLEET_DATA_KEY`, `MAIL_*`, `SMTP_URL`, `VAULT_*`, `AGENT_MSI_DIST_DIR`, `DEVICE_HELLO_RATE`, `WAKE_CONFIRM_SEC`.

| # | Rule |
|---|---|
| 3.1a | F0 (owner of `infra/`) adds to the compose `api` environment: `FLEET_DATA_KEY: ${FLEET_DATA_KEY:?set FLEET_DATA_KEY in infra/.env}`, `FLEET_DATA_KEYS_PREVIOUS: ${FLEET_DATA_KEYS_PREVIOUS:-}`, `MAIL_DRIVER: ${MAIL_DRIVER:-log}`, `SMTP_URL: ${SMTP_URL:-}`, `MAIL_FROM: ${MAIL_FROM:-}`, `SMTP_REQUIRE_TLS: ${SMTP_REQUIRE_TLS:-true}`, the three `VAULT_*` keys, `AGENT_DIST_DIR: /data/agent-dist` and `AGENT_MSI_DIST_DIR: /data/agent-msi` (mounted read-only from `./data/agent-dist` and `./data/agent-msi`, the C open item), `AGENT_MIN_VERSION`, `AGENT_ANDROID_APP_URL`, `DEVICE_HELLO_RATE`, `WAKE_CONFIRM_SEC`, `BACKUP_RETENTION_DAYS`, and documents every one in `infra/.env.example` (`FLEET_DATA_KEY=` empty, as a secret). Every non-secret key is passed as `${KEY:-<the config.ts default>}` so an `.env` that omits it keeps today's behaviour (an empty `AGENT_MIN_VERSION` would otherwise fail `AGENT_VERSION_RE`); `config.ts` treats an empty `MAIL_FROM` as its default (F0), because `str(def)` returns `''` for an empty variable |
| 3.1b | **Parity check (new, F0):** `scripts/infra/compose.mjs` gains `checkApiEnvParity(configKeys, composeKeys)`, and `pnpm validate:infra` fails when a key of `envSchema` in `apps/api/src/config.ts` is neither passed by the compose `api` service nor listed in a `DEV_ONLY_ENV` allow-list (`NODE_ID`, `PGLITE_DIR`, `AGENT_DEV_STUB`, `EGRESS_ALLOW_HTTP`, `EGRESS_ALLOW_LOOPBACK`, `SSO_DEV_DNS_SERVERS`, `ERASURE_DEV_COOLING_OFF_SEC`) — the class of defect, not only this instance |
| 3.1c | `FLEET_DATA_KEYS_PREVIOUS` = comma list of `<keyId>:<64 hex>`, open-only (the E §2.1 `ORG_SECRETS_KEYS_PREVIOUS` shape). When it is non-empty, `FLEET_DATA_KEY` must carry an explicit `<keyId>:` prefix and no previous entry may repeat it (boot problems, `config.ts`, F0) |
| 3.1d | `macKeys(ctx)` (`apps/api/src/fleet/common.ts`) returns the current key and every previous key. `decryptMac` that succeeds under a previous key re-seals under the current key and writes `device.mac_enc` **and** `device.mac_hash` back with a compare-and-set on the old `mac_enc` (losing the race is not an error). `mac_hash` is recomputed because it is keyed by an HKDF of the fleet key; nothing queries it today (verified: it is only selected in `packages/db/src/repo/devices.ts`), so a stale hash during rotation harms nothing |
| 3.1e | `pnpm secrets:reseal` (`scripts/reseal-org-secrets.mjs`) re-seals every `device.mac_enc` not under the current fleet key with the same compare-and-set, after the org secrets; it prints one line per column and exits 1 when any value failed to open |
| 3.1f | `docs/release.md` gains the fleet-key rotation procedure (set the new key with a key id, move the old one to `FLEET_DATA_KEYS_PREVIOUS`, restart, run `pnpm secrets:reseal`, remove the old key after the reseal reports zero) |

### 3.2 The residency print (binding; closes the E §15.8 headroom item)

| # | Rule |
|---|---|
| 3.2a | The print of `/app/residency` fits **one A4 page with at least 15 mm of free height** for a report with **10 flows**, a 200-character storage `detail`, every optional block present (SSO with 5 verified domains, the AI acknowledgement, the erasure block in its `cooling_off` state) and an org name of 100 characters |
| 3.2b | Measured, not eyeballed: `enterprise-residency.spec.ts` (fixes) emulates print media (`page.emulateMedia({ media: 'print' })`) at the A4 printable box (210 × 297 mm less the 12 mm margins), reads the bounding box of `.residency-report`, and asserts its height is at most 273 mm − 15 mm; it also prints to PDF and asserts exactly one page (the existing `pdfPageCount`) and the full public key in the text |
| 3.2b2 | **The erasure block is built in parallel** (stream erasure), so its print size is fixed up front: in print, `<ResidencyErasureSlot>` occupies **at most 12 mm** (three lines of 8 pt: state, date, note). F0's stub renders a placeholder of exactly that height with the longest §5.7 text, so the fixes measurement holds before erasure merges; erasure's `apps/web/test/residencyErasure.test.tsx` asserts the block's print height stays within 12 mm with every §5.7 text shown in full (nothing clipped; the texts were chosen to fit three 8 pt lines across the 186 mm printable width), and the coordinator re-runs `enterprise-residency.spec.ts` after both merge |
| 3.2c | Allowed means: a two-column flows table in print, 8 pt table text, shortened column headings, wrapping the storage detail. **No field is dropped from the print** and no state is shown by colour alone (E §11) |

### 3.3 Vendor request shapes and Zoho data centres (binding: how they are verified)

The adapters in `apps/api/src/integrations/adapters/{jira,servicenow,freshdesk,zoho-desk}.ts` implement E §4.6, tested only against `apps/api/test/fake-ticketing.ts`. `ZOHO_DATA_CENTERS` ships empty (E §16.3), so no `zoho_desk` configuration validates today.

| # | Rule |
|---|---|
| V1 | **Sources are vendor documentation only**: the vendor's own public REST API reference or developer documentation (for example `developer.atlassian.com`, the ServiceNow product documentation site, `developers.freshdesk.com`, `desk.zoho.com/DeskAPIDocument`, Zoho's accounts and data-centre documentation). Blogs, forums, SDK source and third-party libraries are not sources. No vendor API is called and no account is created |
| V2 | For each of E §4.6's cells (test, create, append, auth; for Jira cloud and data center separately) the stream records: the method and path, every request field the adapter sends, the response fields it reads (`id`, `key`, `number`, `sys_id`, `webUrl`), the auth header, and the URL and the date read of the page that shows it |
| V3 | Where documentation **confirms** the shape: the cell is marked verified. Where it **contradicts** it: the adapter, its fake and `ticketing-adapters.test.ts` are corrected in the same change, and E §4.6 is amended with a pointer here. Where it **cannot be confirmed** (the page is missing, behind a login, or silent on a field): the cell is marked **unconfirmed** with the reason, and nothing is guessed |
| V4 | `INTEGRATION_VERIFICATION` (`enterprise/integrations.ts`; F0 lands every row `{ verified: false, sources: [], unconfirmed: [] }`) records per type `{ verified: boolean, sources: { url, readOn: ISO date }[], unconfirmed: string[] }`; `verified` is true only when no cell of that type is unconfirmed. The same record is copied into §3.3 of this file as a table (type, cell, source URL, date, state) by the fixes stream |
| V5 | A type with `verified: false` stays usable (it shipped in E), but the integrations page card says "This request format has not been fully verified against <vendor>'s documentation (<n> items). Use Test before relying on it." and lists the unconfirmed items; `integration.tested` remains the operational gate |
| V6 | **Zoho Desk**: a `ZOHO_DATA_CENTERS` row ships only when **both** its `deskHost` and `accountsHost` appear in Zoho documentation as that data centre's API and accounts hosts; an unverifiable row is left out. Each shipped row's `region` is set only when Zoho documents the data centre's location and it maps to one of our regions, else `null`. `zoho_desk` becomes usable exactly when at least one row ships. The `ia_ticket_pushes_total` series and the residency `leavesRegion` rule (E §6.2b) need no change |

### 3.4 Keep (C §10 D5) on Windows and Linux (binding)

Verified: `deletes_on_exit(role, kept)` (`ia-core/src/teardown.rs`) and the Linux `selfdel::plan(&env, &exe, kept)` with `keep_copy` exist, but `serve.rs` derives `kept` from `--no-self-delete` only, the Linux path calls `plan(.., false)`, no Windows Keep copy is implemented, and no UI sets Keep.

| # | Rule |
|---|---|
| 3.4a | **Desk UI only.** A "Keep IndiansAssist on this computer" checkbox (default off) in the pill menu and in the ended view, on Windows and Linux, actionable only by physical input (the C §3.5 guard in `ia-ui/src/guard.rs`, the E 7.3c pre-injection guard on Linux). Its text: "Keep IndiansAssist on this computer. It will not be deleted when the session ends. It does not install a service and does not start by itself." |
| 3.4b | **The console cannot set Keep** (C §3.5 lists "tick Keep" among the things the technician's injected input must never do; a console button would be the same self-approval by another route). The agent reports the choice with a new control event `ctl.event keep { kept: boolean }` (`agent/control.ts`, F0) each time it changes; the console shows "The user chose to keep IndiansAssist on this computer." in `KeepState` behind `<DeskKeepSlot>`, read-only. No audit entry (C D5: the choice is local) |
| 3.4c | **Applier.** At a clean exit with Keep: Windows copies the running exe to `%LOCALAPPDATA%\IndiansAssist\IndiansAssist.exe` (`CREATE_NEW` semantics, replacing an older kept copy only through a temp file and rename), keeps the HKCU protocol handler, and removes the logs and `run\` but not the copy; Linux applies `selfdel::plan(.., true)` (copy to `$XDG_DATA_HOME/indiansassist/IndiansAssist`, mode 0755, keep the handler). Both then open `${WEB_ORIGIN}/join?kept=1` once in the default browser (C L3; `ShellExecuteW` / `xdg-open`) |
| 3.4d | **A kept copy never deletes itself.** An instance whose `current_exe()` is the Keep location treats Keep as chosen: D1 removes its logs and run directory only. Its pill menu offers "Remove IndiansAssist from this computer after this session" instead, which makes that one exit a normal D1 self-delete of the kept copy |
| 3.4e | **Automation.** `--no-self-delete` means no file change at exit at all: neither self-delete nor the Keep copy nor the browser launch. The applier and the planner are tested only against a temporary root (Windows: `KnownFolders` injected with a temp directory; Linux: a temporary `XdgEnv`), including the "kept copy runs again" and "remove after this session" paths |

### 3.5 Other E open items

The E §15.8 rows not named above stay open and unchanged: the transcript TTL assertion, the Linux self-delete of the built binary (a manual check), the tray and pill against a real window manager, the bash-only Linux scripts. The "Windows P3 data dir hard-coded" row is closed by F0: `apps/web/playwright.config.ts` reads `E2E_DATA_DIR` for the P3 suite too (default unchanged, `./data/e2e-p3`), and `reset-data-p3.mjs` honours it with the `./data` containment check of `reset-data.mjs`.

---

## 4. Email invites and password reset (stream mail)

### 4.1 Transport (binding)

| # | Rule |
|---|---|
| 4.1a | The D `Mailer` stays the only transport: `log` (default) and `smtp` (nodemailer 8, already installed, MIT-0). `MailMessage.attachments` becomes optional (an invite or reset mail has none). Every mail is **plain text only** (no HTML part), `From: MAIL_FROM`, a fixed subject per kind, and display names sanitised with `sanitiseText` and stripped of CR and LF so no header can be injected |
| 4.1b | `SMTP_REQUIRE_TLS` (new, default `true` when `NODE_ENV=production`, else `false`): with `true` the transport refuses to send without STARTTLS or implicit TLS (`smtps:`). `MAIL_DRIVER=smtp` with `SMTP_REQUIRE_TLS=false` and a non-loopback SMTP host under `NODE_ENV=production` is a boot problem |
| 4.1c | **Capability.** Password reset and invite mail exist only when `MAIL_DRIVER=smtp`. `GET /api/v1/auth/options` (new, public, mail stream) answers `{ passwordReset: boolean, inviteMail: boolean }` from config only (never per account), and the login page shows "Forgot your password?" only when `passwordReset` is true. With the `log` driver nothing that carries a token is "sent" (the log line never contains the token or the link) |
| 4.1d | The residency report's `mail` flow `dataSent` (E §6.2b) becomes "consent receipts, invitations, password-reset links and break-glass and erasure notices" (F0 edits the constant in `services/residency.ts`) |
| 4.1e | Metric `ia_mail_sent_total{kind,result}` with `kind` ∈ `MAIL_KINDS` (`invite`, `reset`, `reset_notice`, `break_glass`, `receipt`, `erasure`) and `result` ∈ `sent`, `failed`, `no_mailer` |

### 4.2 Invites by email (binding)

| # | Rule |
|---|---|
| 4.2a | `POST /api/v1/users/invite` (A, extended): body gains `sendEmail?: boolean` (default `true` when `inviteMail`, otherwise ignored). The existing behaviour is unchanged: the invite token on `user.invite_token_hash` (7-day TTL, `INVITE_TTL_MS` in `routes/users.ts`) and the `inviteUrl` (`${WEB_ORIGIN}/invite#i=<secret>`) in the reply, so the copy-link flow stays. The reply gains `mailed: boolean`. The mail is sent after the transaction commits; a send failure never fails the invite |
| 4.2b | Mail text: "<inviter display name> invited you to <org display name> on IndiansAssist as <role>. Open this link to set your name and password: <inviteUrl>. The link works once and expires on <date>." For an org with `sso_required` the link is replaced by "Sign in with your organisation's single sign-on: <beginUrl>" (the invitee is activated by the E §3.6 rule 2 SSO login, and `accept-invite` refuses them anyway, E 3.7b) |
| 4.2c | `POST /api/v1/users/:id/invite/resend` (new, org_admin): only for a user in status `invited` (else `409 bad_state`); mints a **new** invite secret (the old hash is replaced, so an earlier link stops working), resets the 7-day expiry, sends the mail when `inviteMail`, and answers `200 { inviteUrl, mailed, inviteExpiresAt }`. `user.invite_mailed_at` (new column) is set on each successful send and shown on the users page ("Invitation emailed <date>") |
| 4.2d | Chain: `user.invited` (A) is unchanged; each mail attempt chains `user.invite_mailed { userId, delivered, cause }` (actor user, the inviting admin), and a resend chains `user.invite_resent { userId }` before it |

### 4.3 Password reset (binding)

| # | Rule |
|---|---|
| 4.3a | `POST /api/v1/auth/password-reset/request { email }` (public, region of the login page) **always** answers `202 {}` with no body difference, whatever the email; the lookup and the mail happen after the reply (`setImmediate`), so the latency does not depend on the account |
| 4.3b | Eligibility, decided after the reply: the user exists in this region, `status = 'active'`, `password_hash` is not null, and the org is not erasing. If the org has `sso_required` and the user is not `sso_break_glass`, the user gets **no reset link**; a notice mail is sent instead ("Your organisation signs in with single sign-on, so there is no password to reset. Sign in here: <beginUrl>") (outcome `sso_notice`). A user with `password_hash = null` (an SSO-only or JIT account) also gets the SSO notice when the org has SSO configured, and nothing otherwise. Ineligible users and unknown emails get nothing |
| 4.3c | Token: 32 CSPRNG bytes, base64url; a `password_reset` row stores `token_hash = sha256Hex(token)`, `expires_at = now + LIMITS.passwordResetTtlMin` (30), `used_at` null. Issuing a new token marks every unused token of that user superseded (`used_at = now`, `superseded = true`). At most `LIMITS.passwordResetPerHour` (3) mails per user per hour **of either kind** (reset link or SSO notice), counted with `Presence.incr('ia:resetmail:<userId>', 3600)` before any mail is sent, because an SSO notice creates no `password_reset` row and would otherwise escape the cap (mail-bombing); beyond that the request is dropped silently (outcome `throttled`) |
| 4.3d | Link: `${WEB_ORIGIN}/reset#t=<token>` (fragment; the page reads it, removes it from the address bar with `history.replaceState`, and posts it). Mail text names the org, the expiry time and "If you did not ask for this, ignore this email; your password is unchanged." It never names the requesting IP |
| 4.3e | `POST /api/v1/auth/password-reset/confirm { token, newPassword }` (public): looks the row up by `sha256Hex(token)` with a constant-time comparison; unknown, used, superseded or expired → `400 reset_invalid` (one code, one message); `newPassword` per `passwordSchema` (A); the user must still be eligible by 4.3b at confirm time, else `403 sso_required` (SSO case) or `400 reset_invalid`. On success, in one transaction: argon2id hash (A `hashPassword`), `used_at = now`, every `auth_session` of the user revoked, then their sockets closed with `4401` (the A password-change path), chain `auth.password_reset { userId, revokedSessions }` (actor user). Answer `204`; **no session is minted** (the user signs in normally, so a stolen link alone never yields a live session without the new password being used) |
| 4.3f | A successful reset of a **break-glass** account while `sso_required` mails every other active org_admin ("<name> reset the break-glass password at <time>"), as E 3.7d does for a break-glass login |
| 4.3g | Each request for an existing user chains `auth.password_reset_requested { userId, outcome }` (actor system) with `outcome` ∈ `RESET_OUTCOMES` (`mailed`, `sso_notice`, `throttled`, `send_failed`, `no_mailer`); unknown emails chain nothing (there is no org) and count only in `ia_password_resets_total{result="unknown"}` |
| 4.3h | `sweepMailTokens` (mail) deletes `password_reset` rows 24 h after `expires_at` or `used_at` |

### 4.4 REST (stream mail)

| Method / path | Roles | Request | Response and errors |
|---|---|---|---|
| `GET /api/v1/auth/options` | none | | `200 { passwordReset, inviteMail }` |
| `POST /api/v1/auth/password-reset/request` | none | `{ email }` (`z.string().min(1).max(254)`, as `loginRequestSchema`) | `202 {}`; `429 rate_limited` (per IP only) |
| `POST /api/v1/auth/password-reset/confirm` | none | `{ token: base64url 43, newPassword }` | `204`; `400 reset_invalid`, `400 validation_failed`, `403 sso_required`, `429 rate_limited` |
| `POST /api/v1/users/invite` (A) | org_admin | `+ sendEmail?` | `201 { user, inviteUrl, mailed }` |
| `POST /api/v1/users/:id/invite/resend` | org_admin | | `200 { inviteUrl, mailed, inviteExpiresAt }`; `404 not_found`, `409 bad_state`, `429 rate_limited` |

Web: `/reset` (`PasswordResetPage`: request form with the plain sentence "If an account exists for that address, we sent a link to it." after submit, and the confirm form when the fragment holds a token); the login page link; the users page "Resend invitation" button and "Invitation emailed <date>". The `infra/nginx/web.conf` auth rate-limit location regex gains `password-reset/(request|confirm)` (F0).

---

## 5. Org erasure (stream erasure)

### 5.1 Model and states (binding)

One `org_erasure` row per attempt; at most one open (`pending_confirmation`, `pending_approval`, `cooling_off`, `executing`) per org (partial unique index).

| State | Entered by | Leaves to |
|---|---|---|
| `pending_confirmation` (single-admin path, 5.2f) | `POST /orgs/current/erasure { solo: true }` by the org's only eligible admin | `cooling_off` (the confirmation link opened within `LIMITS.erasureConfirmTtlHours` = 24 h, with `cooling_off_until = now + LIMITS.erasureSoloCoolingOffDays` = 14 days), `expired` (not opened in time), `cancelled` |
| `pending_approval` | `POST /orgs/current/erasure` by org_admin A | `cooling_off` (approval by org_admin B ≠ A), `cancelled` (any org_admin), `expired` (no approval within `LIMITS.erasureApprovalTtlDays` = 7) |
| `cooling_off` | approval | `executing` (the sweeper at `cooling_off_until`), `cancelled` (any org_admin) |
| `executing` | the sweeper lease holder | `completed`, or stays `executing` and resumes after a crash (§5.3 is idempotent per step) |
| `completed` / `cancelled` / `expired` | terminal | — |

### 5.2 Preconditions (binding)

| # | Rule |
|---|---|
| 5.2a | Request and approval each require: role org_admin, an `auth_session` minted within `LIMITS.erasureReauthMin` (15) minutes (else `401 reauth_required`; the console asks the user to sign in again, password or SSO), and `confirmSlug` equal to the org slug (else `400 erasure_confirm_mismatch`) |
| 5.2b | **Eligible approver** = an active org_admin who is not the requester, whose `user.role_since` (new column, §13.2: set when the user is created and on every role change, backfilled to `created_at`) is at least `LIMITS.erasureApproverMinDays` (7) days old, and whose `user.role_granted_by` (new column: the inviter for an invited user, the actor of the last role change, null for the signup admin) is **not** the requester. A request needs at least one eligible approver to exist (else `409 erasure_second_admin`); an approval by anyone else → `409 erasure_second_admin`. This closes the one-person path of inviting (the invite reply carries `inviteUrl`, `routes/users.ts`) or promoting a second admin and approving with it. There is no operator override; an org with a single eligible admin uses 5.2f (user decision 2) |
| 5.2c | Cooling-off: `cooling_off_until = approved_at + LIMITS.erasureCoolingOffDays` (7 days). `ERASURE_DEV_COOLING_OFF_SEC` (development only, refused with `NODE_ENV=production` as a boot problem) shortens it for tests and smokes |
| 5.2d | **At request time** the api mails every active org_admin and auditor (when `smtp`): "<requester> asked to permanently erase <org>. It needs a second administrator's approval. Any administrator can cancel it at <url>." **On approval** it mails them again: "<requester> and <approver> scheduled the permanent erasure of <org> on <date>. Any administrator can cancel it before then at <url>. After it runs, its signed certificate will be at <certificateUrl>." From the request on, every signed-in user of the org sees `<ErasureBanner>` (fed by the notice of `GET /orgs/current/erasure`, readable by every role) with the state, the date, the certificate URL and, for org_admins, a Cancel button. The org otherwise works normally during cooling-off; org_admins and auditors are told to download the audit export (`POST /api/v1/audit/export`, A) and the signed residency report before the date, and to keep the certificate URL, because after completion nobody can sign in |
| 5.2f | **Single-admin path** (the user's decision of 2 Nov 2026, W124). When the org has **exactly one** active org_admin and therefore no eligible approver, that admin may request with `solo: true`. Extra conditions: no org_admin was demoted or disabled in the last `LIMITS.erasureApproverMinDays` (7) days (read from the chain's `user.role_changed` / `user.status_changed` entries), so the path cannot be reached by first removing the other admins; re-authentication within 15 minutes and the typed slug (5.2a). The api mints a 32-byte confirmation token (stored as `sha256Hex`, single use, 24 h) and mails `${WEB_ORIGIN}/app/settings/erasure#confirm=<token>` to the admin (when `smtp`); with the `log` driver the link is shown **once** in the request reply and on screen, and never again. Opening it requires the same admin, signed in within 15 minutes, and moves the erasure to `cooling_off` for **14 days**. A non-solo request in such an org answers `409 erasure_second_admin { soloAvailable: true }` so the console offers the solo path; a solo request in an org that has an eligible approver answers `409 bad_state`. Every other safeguard applies: the admin set freeze (5.2e: no new org_admin while open, so a second admin cannot be added to change the path), the mails at request and at confirmation to the admin and every auditor, the banner for every user, Cancel without a limit, the certificate URL from the request on |
| 5.2e | **Admin set frozen while open.** While an erasure is `pending_confirmation`, `pending_approval` or `cooling_off`, `routes/users.ts` answers `409 erasure_exists` to a role change away from `org_admin`, to disabling an org_admin, and to an invite or role change that would create an org_admin (`assertNoOpenErasure`, F0 call site, erasure body). Cancelling the erasure lifts it. So the requester can neither remove the admins who would cancel nor manufacture an approver |

### 5.3 Execution (binding; the sweeper lease holder, one erasure at a time per node, under a presence lease `erasure:<id>`)

Each step records its completion in `org_erasure.progress` (jsonb, step name → ISO time) and is safe to repeat.

| Step | Action |
|---|---|
| 1 freeze | `org.erasing_at = now`; state `executing`; from here every login, every authenticated request (read or write: the check sits in `principalFromCookieValue` / `authenticate`, `plugins/auth.ts`, beside `assertOrgServed`), every `/signal` hello of the org's Assists, Desks and cameras, and every `device.hello` on `/signal/device` (`fleet/device-socket.ts`) answers `409 org_erasing` / closes `4403`. In the same transaction, everything later steps need from rows they will scrub is computed and stored in `org_erasure.progress.carry`, sealed with `sealOrgSecret` (E §2.1, new purpose `erasure-carry`, `recordId` = the erasure id): the set of `sha256Hex(lower(email))` of every user of the org (for the `login_attempt` delete) and the addresses of active org_admins and auditors (for step 9). A crash after step 5 therefore loses neither. `carry` is deleted at the end of step 9 |
| 2 stop | every live session of the org ended with reason `org_erased` (through `endSessionFlow`); every token revoked; every `auth_session` deleted and its sockets closed `4401`; every enrolled device sent the D deregister on its socket when online and set disabled; every `ticket_push` in `pending` or `retrying` failed with cause `misconfigured` and every `session_summary` in `pending` or `running` failed (cause `provider_disabled`), with no chain entry beyond the existing failure actions; `sweepTicketPushes` and `sweepSummaries` skip any org with `erasing_at` set (erasure stream, one line each); the presence keys derivable from the org's ids are deleted: token state for every token id (`setTokenSession(id, null)`, `clearTokenWaiting`), desk codes and their index per token, held transcripts per session id (`ai/transcript.ts` `transcriptKey`), camera keys per session (`ia:camsess:`), device presence and pending receipts per device id, and the org's Assist registrations |
| 3 chain | `org.erasure_started { erasureId }` (actor system) |
| 4 objects | every object under the org's storage prefix `<region>/<orgId>/` listed with the new `ctx.storage.list(prefix)` (F0: `AsyncIterable<{ key, bytes }>`; fs driver walks the directory, s3 driver pages `ListObjectsV2`) and deleted through `ctx.storage.delete` (recordings, server recordings, and the upload part objects of unfinished uploads, which `routes/recordings.ts` stores as ordinary objects under the recording's key; the S3 driver uses a single `PutObject`, so no S3 multipart upload can be left open); each `recording` row marked deleted (the B Y26 column), the row kept because the chain references it |
| 5 rows | the deletes and scrubs of §5.4, one transaction per table, in the A §4.2 lock order |
| 6 seal | in **one** transaction: chain `org.erased { erasureId, entriesBefore, counts }` (actor system; the last entry the org's chain will ever have), then `UPDATE org SET audit_pepper = NULL, erased_at = now()`; after this commit `insertAuditEntry` refuses the org (`OrgErasedError`, F0 guard), so no later entry can exist, and `piiHash` refuses it too (F0 guard: `pepperedHash(null, v)` would otherwise return `sha256Hex("null:" + v)`, an unpeppered and therefore linkable hash) |
| 7 verify | `verifyChain` (shared `audit/chain.ts`) over every entry of the org with the region's public keys (anchors checked); the result goes into the certificate. The chain needs no pepper to verify (hash material is the stored entry), which is why F3 holds |
| 8 certify | not before `max(LIMITS.summaryTranscriptTtlSec, LIMITS.amtSolMaxMinutes × 60 + 300)` (2,100 s today: the AMT command keys of `fleet/wake.ts`, keyed by command id, are the longest-lived org-bearing key not derived in step 2; the 90-day pending receipts are keyed by device id and deleted in step 2) has passed since step 2, so every presence key the derivation of step 2 might have missed has expired; then build and sign the erasure certificate (§5.5), store it in `org_erasure.certificate`, state `completed` |
| 9 notify | mail the certificate (JSON attachment) to the addresses in `progress.carry`, when `smtp`; then delete `carry`. A crash between 8 and 9 loses only this mail; the certificate stays retrievable (§5.6) |

### 5.4 Deleted, made unlinkable, kept (binding)

Rows referenced by the append-only chain (`audit_entry.org_id`, `audit_entry.session_id`) or by NOT NULL foreign keys from kept rows **cannot be deleted** and are scrubbed instead; the tests assert each foreign key decision against the schema (verified 2 Nov 2026: `audit_entry` references `org` and `session`; `session` references `user`, `token`, `device`; `recording`, `ticket_push`, `session_summary`, `device_action`, `wake_attempt`, `amt_sol` reference `user` and `session` or `device`).

| Data | Treatment |
|---|---|
| `audit_entry`, `audit_checkpoint` | **kept, unchanged** (append-only). Hashed PII (`*Hash` values) becomes **unlinkable** when the pepper is destroyed. **Kept in clear** (verified in the chain schemas): `actor.label` of user actors (technicians' display names at the time, A §5.3); the free text typed by technicians: the entry `reason` column, `data.reason` of `session.accepted` (device branch), `device.action_queued`, `device.amt_sol_opened` and `device.amt_boot_redirected`, and `data.note` of `tamper.acknowledged` (`actions-p4.ts`, up to 500 characters); device-reported `data.detail` of `tamper.alert`; vault reference paths (`refs[].path`); domains, ids, timestamps (user decision 1: kept) |
| `org.audit_pepper` | **destroyed** (set NULL; the only copy outside database backups) |
| `org` | **tombstone**: `name` → `Erased organisation`, `slug` → `erased-<first 8 hex of id>` (frees the slug), `branding` → `{}`, `sso_config` → null, every `sso_*` sealed column and fingerprint → null, `ai_policy` and `unattended_policy` → defaults, `erased_at` set. `id`, `data_region`, `plan_tier`, `created_at` kept |
| `user` | **scrubbed**: `email` → `erased+<userId>@erased.invalid` (unique, the reserved `.invalid` TLD), `name` → `Erased user`, `password_hash`, `auth_ref`, `invite_*`, `device_group_ids` → null, `status` → `disabled`, `sso_break_glass` → false. Kept because sessions, tokens and recordings reference it |
| `technician_seat`, `auth_session`, `sso_identity`, `sso_domain`, `password_reset` | **deleted** |
| `login_attempt` | **deleted** where `email_hash` is in the set computed in step 1 and carried sealed in `progress.carry` (A §4.2: this hash is `sha256Hex(lower(email))`, **unpeppered**, so it stays linkable until deleted; computing it after step 5 would hash the scrubbed addresses); rows expire after 24 h anyway |
| `session` | **scrubbed**: `desk_label`, `desk_user_agent`, `desk_client`, `last_stats` → null. Kept (the chain references it) |
| `session_participant` | `label` → `erased` |
| `session_host`, `session_file` | `session_host` **deleted** (plaintext hosts; its doc comment already says "deletable for erasure"); `session_file.name` → `erased` (NOT NULL), hashes kept |
| `recording` | object **deleted** (step 4), row kept and marked deleted |
| `token` | `label` → null; row kept (revoked) |
| `device` | **scrubbed**: `name` → `Erased device`, `group_name` → null, `tags` → `[]`, `last_ip`, `mac_enc`, `mac_hash`, `notify_email`, `hw_fingerprint`, `interactive`, `lan_segment`, `amt`, `public_key`, `kex_public_key` → null, disabled. Kept (sessions reference it) |
| `device_group` | `name` → `Erased group <first 8 hex of the group id>` (unique per org, so `device_group_org_name_unique` on `(org_id, name)` holds), `description`, `notify_email` → null, `default_tags` → `[]` |
| `device_action`, `wake_attempt`, `amt_sol` | `payload` → `{}`, `result` → null, `reason` → null (NOT NULL `amt_sol.reason` → `erased`), `transcript_ref` → null |
| `playbook` | **deleted** (no foreign key points at it; `playbook_run.playbook_id` is a plain uuid) |
| `playbook_run` | `error` → null; rows kept (session children) |
| `elevation_handover` | kept unchanged: it holds only ids, a token hash, `op_id`, times and the settled `outcome` word (no free text, verified in `schema/playbook.ts`) |
| `integration` | **deleted** when unreferenced, else reset to unconfigured (the E §4.7 rule) |
| `ticket_push` | `content` → `{}`, `external_url`, `external_id`, `external_id_in`, `last_failure` → null |
| `session_summary` | `output`, `detail`, `usage` → null |
| Presence (Valkey or memory) | every key derivable from the org's ids deleted in step 2; anything else expires before step 8 runs (the wait in step 8). `Presence` has no scan, and none is added |
| `ticket_push` / `session_summary` jobs in flight | cancelled in step 2; their sweepers skip the org from step 1 |
| Database backups and object-store versions | **outside the api**: copies remain until the operator's backup retention removes them; the certificate states `BACKUP_RETENTION_DAYS` or "not stated" (user decision 5) |
| Data in third parties (tickets pushed to Jira and others, IdPs, the Anthropic API under its own retention) | **not reachable**; the certificate lists the flow kinds that were enabled at execution so the customer can erase there |

### 5.5 The erasure certificate (binding; `erasure/certificate.ts`)

```ts
export const erasureCertificateSchema = z.object({
  v: z.literal(1),
  erasureId: uuidSchema, orgId: uuidSchema, region: regionSchema,
  requestedAt: isoTimestampSchema, approvedAt: isoTimestampSchema, executedAt: isoTimestampSchema, completedAt: isoTimestampSchema,
  chain: z.strictObject({ entries: z.number().int(), tail: hex64Schema, verified: z.boolean(), failure: verifyFailureSchema.nullable(),
    finalEntry: chainEntrySchema }),                // the org.erased entry itself, so its hash can be recomputed
  deleted: z.record(z.string(), z.number().int()), // table or object kind -> count, e.g. { recordingObjects: 12, auth_session: 40 }
  scrubbed: z.record(z.string(), z.number().int()),
  objectBytes: z.number().int(),
  externalFlows: z.array(z.enum(DATA_FLOW_KINDS)),  // enabled at execution (E §6.2)
  backups: z.string().max(200),                      // 'database backups are kept for 35 days (operator setting)' | 'backup retention not stated'
  signature: z.strictObject({ alg: z.literal('Ed25519'), domain: z.literal('ia-erasure-v1'), kid: kidSchema, pub: z.string(), sig: z.string(), sha256: hex64Schema, signedAt: isoTimestampSchema }),
});
```

Signed exactly like the residency report (E §6.3): the region's token-signing key, input `utf8("ia-erasure-v1\n") || canonicalJsonBytes(certificate without "signature")`, verification over the raw parsed JSON with the key looked up by `kid` (`verifyErasureCertificate(raw, keys)`, never throws). It contains **no name, slug, email or reason**. `scripts/verify-erasure.mjs <certificate.json> [--keys <well-known.json> | --pub <base64url>] [--export <audit.jsonl> --digest <digest.json>]` prints `OK <kid> <sha256>` or the cause; with `--export` and `--digest` it also checks that every entry of an export taken during cooling-off recomputes to the hash listed at its `seq` in the chain digest, that the digest links `prevHash` to `hash` without a gap up to `chain.tail`, and that `chain.finalEntry` recomputes to `chain.tail`. Vector: `packages/shared/test/fixtures/erasure/certificate-signature.json`.

### 5.6 REST (stream erasure)

| Method / path | Roles | Request | Response and errors |
|---|---|---|---|
| `GET /api/v1/orgs/current/erasure` | every role | | `200 { erasure: OrgErasure \| null }` (the open one, else the latest terminal one) for org_admin and auditor; `200 { notice: { state, coolingOffUntil, certificateUrl } \| null }` for every other role (the banner's input; no names) |
| `POST /api/v1/orgs/current/erasure` | org_admin | `{ confirmSlug, reason?: string (<= 500), solo?: boolean }` | `201 { erasure, confirmUrl?: string }` (`confirmUrl` only for a solo request under the `log` driver, shown once, 5.2f); `400 erasure_confirm_mismatch`, `401 reauth_required`, `409 erasure_exists`, `409 erasure_second_admin`; chains `org.erasure_requested { erasureId }` (the reason is stored in the row and scrubbed at step 5, never chained) |
| `POST /api/v1/orgs/current/erasure/:id/confirm` | the requester of a solo erasure | `{ token }` (from the link fragment) | `200 { erasure }`; `400 erasure_confirm_invalid` (unknown, used or expired token), `401 reauth_required`, `403 forbidden` (another user), `409 bad_state`; chains `org.erasure_confirmed { erasureId, coolingOffUntil }` |
| `POST /api/v1/orgs/current/erasure/:id/approve` | org_admin ≠ requester | `{ confirmSlug }` | `200 { erasure }`; `400`, `401`, `404`, `409 bad_state`, `409 erasure_second_admin`; chains `org.erasure_approved { erasureId, coolingOffUntil }` |
| `POST /api/v1/orgs/current/erasure/:id/cancel` | org_admin (no fresh sign-in and no slug needed: cancelling must be easy; never rate limited, §2.3) | | `200 { erasure }`; `409 erasure_not_cancellable`; chains `org.erasure_cancelled { erasureId, fromState }` |
| `GET /api/v1/erasures/:id/certificate` | none | | `200` the signed certificate (`Cache-Control: no-store`); `404 not_found` unless `completed` |
| `GET /api/v1/erasures/:id/chain-digest?after=<seq>&limit=<1..10000>` | none | | `200 { items: { seq, hash, prevHash }[], nextAfter: int \| null }` (no material, action or label); `404` unless `completed` |

`OrgErasure` = `{ id, state, requestedBy: { id, name }, requestedAt, approvedBy: { id, name } | null, approvedAt, coolingOffUntil, cancelledBy, cancelledAt, executedAt, completedAt, certificateUrl: string | null }` (names are display names; after completion they read "Erased user"). `certificateUrl` = `${API_ORIGIN}/api/v1/erasures/<id>/certificate`, set from the request on (the id is known then), shown on the erasure page and in the banner, and included in both mails of 5.2d, because after completion nobody of the org can sign in and the `log` mail driver delivers nothing; it answers `404` until the erasure completes. An unapproved request expiring chains `org.erasure_expired { erasureId }` (actor system). Web: `/app/settings/erasure` (`ErasurePage`): the state, the two-person steps with typed slug confirmation, the cooling-off date, Cancel, the export and residency download links, the certificate link after completion; text in words, a live region for state changes.

### 5.7 Residency report (binding; `rest-residency.ts`, non-additive)

`erasure` becomes `{ available: boolean, state: 'none' | ERASURE_STATES, scheduledFor: ISO | null, note: string }` (`available` widened from `z.literal(false)`; `state` and `scheduledFor` optional on the wire, always sent by a Phase F api). A Phase F api sends `available: true` and the note "Erasure destroys this organisation's personal data and the audit pepper after two administrators approve it and a 7-day cooling-off period (an organisation with a single administrator: a mailed confirmation and a 14-day cooling-off period). Technician display names and typed reasons stay in the audit chain." `retention.piiInChain` becomes "Personal data in the audit chain is stored only as hashes with a per-org pepper; erasure destroys the pepper, after which the hashes cannot be linked to anyone." In-repo tests asserting the literal are updated in the same change (`apps/web/test/residencyReport.test.tsx`, `apps/api/test/residency.test.ts`, `packages/shared/test/enterprise-signing.test.ts` vector regenerated).

---

## 6. The phone as a support camera (stream camera)

### 6.1 Flow (binding)

1. In a live P1, P3 or P4 session, the session's Assist opens **Phone camera** in `<CameraSlot>`; the console calls `POST /sessions/:id/camera-links` and shows the QR code (existing `components/QrCode.tsx`), the short link and the code, plus **Send to the Desk's chat**.
2. **Send to the Desk's chat** posts "To show me something with your phone's camera, open this on your phone: <url> (code <XXXX-XXXX-XXXX>)" through the console's existing chat path (P1 data channel or relay, P3/P4 `ia.chat`). In the **P1 room** the chat panel renders the QR beside that message (`<CameraLinkAccessory>` through `ChatPanel`'s `messageAccessory`, shown only when the text contains exactly a `${WEB_ORIGIN}/c/<code>` URL), so the Desk person scans it from their screen. The native agents draw the same QR beside that message in their chat panel (Windows and Linux: `ia-ui` with the `qrcode` crate, stream linux-p4 in wave 2; macOS: stream apple), the Android host makes the link tappable (it is the phone already; stream mobile), and the person can always open `${WEB_ORIGIN}/c` and type the code (W104).
3. The phone opens `/c/<code>`; the page connects to `/signal`, sends `camera.hello { code }`, receives the org and technician names, and shows the consent screen. Nothing is captured before the tap.
4. On **Start camera** the page calls `getUserMedia` and offers its track to the Assist; the Assist sees it live, can freeze and snapshot; either side can stop.

### 6.2 Link and code (binding)

| # | Rule |
|---|---|
| 6.2a | `cameraId` = uuid; `code` = 12 Crockford base32 characters (60 bits) from a CSPRNG, shown `XXXX-XXXX-XXXX`, matched case-insensitively with `I L O U` mapped as Crockford specifies; `url` = `${WEB_ORIGIN}/c/<12 chars>` |
| 6.2b | Stored only in presence: `ia:cam:<sha256Hex(code)>` = `{ cameraId, sessionId, orgId, region }` with TTL `LIMITS.cameraLinkTtlSec` (600); `camera.hello` takes it with `Presence.consume` (single use, cluster-wide). The REST reply is the only place the code appears; it is never logged (redact path `*.code` is **not** added, E §14; the camera module never passes the code to the logger) |
| 6.2c | One camera per session (`LIMITS.cameraPerSession` = 1), enforced **cluster-wide** through a second presence key `ia:camsess:<sessionId>` = `{ cameraId, codeHash, state: 'linked' \| 'connected' }`, written with the link (TTL `cameraLinkTtlSec`), refreshed to the session's lifetime when the phone connects, and deleted when the camera ends: a second link while it exists → `409 camera_busy`. `DELETE .../camera-links/:cameraId` on any node reads it, checks the `cameraId`, and deletes `ia:cam:<codeHash>` (pending) or asks the session owner node to end the camera (connected, through the bridge) |
| 6.2d | The link is refused for `p2_extension` (`409 camera_unsupported`), for a session not `active` (`409 bad_state`), and for anyone but the session's Assist |
| 6.2e | `infra/nginx/web.conf` (F0): `location = /c` (the code-entry page; `^~ /c/` does not match it) and `location ^~ /c/ { access_log off; try_files /index.html =404; }`, both carrying the camera `Permissions-Policy` of §11, so a code in the path is never written to the access log and only these pages may use the camera |

### 6.3 Phone page and consent (binding; `apps/web/src/camera/CameraJoinPage.tsx`)

| # | Rule |
|---|---|
| 6.3a | Consent screen: org display name (branding), "<technician display name> from <org> asks to see what your phone's camera shows, live, during your support session.", "Only the camera is shared: not your screen, microphone, photos or location." Then, from `camera.hello.ok.recording`, either "This support session is being recorded under <org>'s policy, so the camera will be recorded too." or "The camera is not recorded." Then "The technician can take still pictures, which are noted in the session's audit log by a fingerprint. You can stop at any time." Buttons **Start camera** and **No thanks**. **No thanks** sends `camera.stop { reason: 'declined' }` |
| 6.3b | Capture: `getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } } })`, only from the tap. A **Switch camera** button toggles `facingMode`; a **Light** button appears only when the track reports the `torch` capability. The page shows a persistent "Your camera is being shared with <technician>" bar and **Stop**. Page hidden for more than 60 s (`visibilitychange`) stops the camera |
| 6.3c | Permission denied, no camera, or an insecure context → the page explains in words and sends `camera.stop { reason: 'no_camera' | 'permission_denied' }` |
| 6.3d | The page loads no third-party resource, sets no cookie and stores nothing (no `localStorage`); the session cookie is never needed (a phone is not signed in) |

### 6.4 Signaling (binding; `schemas/signal-camera.ts`, `signal/camera.ts`)

A new hub side `camera`, beside `assist`, `desk` and `recorder` (`Conn.side`). The upgrade is the existing `/signal` path with the web Origin (so not `deskOnly`); `camera.hello` needs no principal and is refused on a socket that already said hello.

| Message | Dir | Shape and rule |
|---|---|---|
| `camera.hello` | phone → S | `{ code }` or `{ resumeKey }` (43 base64url, from `hello.ok`, valid `LIMITS.cameraResumeSec` = 60 after a drop); a bad, spent or expired code or key → `error camera_link_invalid` + close `4403`; a session that ended meanwhile → the same |
| `camera.hello.ok` | S → phone | `{ cameraId, sessionId, org: { displayName }, technician: { name }, iceServers, resumeKey, limits: { maxBitrateKbps }, recording: { server: boolean, console: boolean } }`; TURN credentials for the principal `camera:<cameraId>`, which `TurnPrincipal` (`packages/shared/src/turn.ts`, today the closed union `user:` \| `desk:` \| `recorder:`) gains (F0, §16.2) |
| `camera.ready` | phone → S | `{ cameraId, width, height, facing: 'environment' \| 'user' \| 'unknown' }` after the track starts; chains `camera.started` |
| `camera.stop` | phone → S | `{ cameraId, reason: CAMERA_STOP_REASONS }` |
| `camera.state` | S → Assist (the session's Assist socket only), and S → a **P1** Desk socket | `{ cameraId, state: 'linked' \| 'joined' \| 'live' \| 'ended', reason?: CAMERA_STOP_REASONS }`; native Desks are not sent it (their protocol does not know it) |
| `camera.closed` | S → phone | `{ reason }` then close `1000` |
| `webrtc.offer` / `answer` / `ice` | phone ↔ Assist | the existing messages with `peer: 'camera'` (`WEBRTC_PEERS` += `camera`). `routeCameraWebrtc`: from the camera side → the session's `assistConnId` with `peer: 'camera'`; from the Assist with `peer: 'camera'` → `live.camera.connId`; any other combination → `error forbidden`. Only while the session is `active` (else `consent_required`, as today) |

`CAMERA_CLIENT_TYPES = ['camera.hello', 'camera.ready', 'camera.stop', 'webrtc.offer', 'webrtc.answer', 'webrtc.ice', 'ping', 'pong']`. `Live.camera` (F0 adds, null) = `{ cameraId, connId, startedAt: number | null, resumeKeyHash }`. With several nodes the camera socket is a side like the Desk: after `camera.hello` resolves the session, the bridge forwards its frames to the owner node (`Bridge.ownerFor`). Ending the session ends the camera (`camera.closed { reason: 'session_ended' }`); a dropped phone socket keeps `Live.camera` for 60 s for a resume, then ends it with `reason: 'disconnected'`.

### 6.5 Media path and coexistence (binding)

| Item | Rule |
|---|---|
| Connection | a **separate** `RTCPeerConnection` between the phone and the Assist browser; the phone offers `sendonly` video, the Assist answers `recvonly`; DTLS-SRTP end to end, TURN relays only ciphertext; the server never has media keys. The sender caps `maxBitrate` at `LIMITS.cameraMaxBitrateKbps` (1500) |
| Security code | **commit before reveal**, the C §1.3 order, over a negotiated data channel `ia.cam` (`id: 0`, `negotiated: true`) inside the camera peer connection: (1) the Assist sends `{ t: 'commit', c: hex(sha256(nA)) }` with `nA` 32 random bytes; (2) the phone, only after receiving the commit, sends `{ t: 'nonce', n: base64url(nP) }`; (3) the Assist reveals `{ t: 'reveal', n: base64url(nA) }` and the phone checks it against the commit (a mismatch ends the camera with `reason: 'error'`). Both compute `h = sha256(utf8("ia-cam-v1\n" + offerFpr + "\n" + answerFpr) ‖ nA ‖ nP)`, where each fingerprint is the `a=fingerprint` value **of the DTLS certificate that side actually negotiated** (`RTCPeerConnection.sctp.transport` / the remote description it applied), and show `String(u32be(h[0..4]) % 1_000_000).padStart(6, '0')` as `123 456`, the reduction `packages/shared/src/agent/sec.ts` uses for the C SAS. A server in the middle that ran two DTLS legs would have to fix its nonce on one leg before learning the other leg's, so it matches the codes with probability 10⁻⁶ per attempt instead of grinding certificates until two 20-bit values collide (which a code from the fingerprints alone allows). The technician compares the code with the phone holder by voice; the console shows "Camera code not confirmed" until the technician ticks **Codes match**; a mismatch is the technician's cue to stop. The code is advisory (as the P1 trust model is), but no longer forgeable by the server |
| P1 | the P1 Desk peer connection and the A.2 recorder peer (Desk ↔ recorder) are untouched; the Desk never receives camera video (A D8 stays true) |
| P3 / P4 | the agent's peer, its `ia.sec` channels and the SAS gate are untouched; the camera is not part of `ia.sec` (the agent is not involved) |
| Recorders | **the phone camera is recorded whenever the session is recorded** (the user's decision, W125), as separate camera recordings, by rule 6.5a |
| P2 | no camera (PRD 4: "No") |

**6.5a Recording the camera (binding).** The camera is recorded by exactly the paths that record the session at that moment, each as a **separate recording** of the camera track (`recording.source = 'camera'`, `recording.camera_id` set; the Desk's recordings are `source = 'desk'`, the default for every existing row), so playback, retention (B Y26), deletion, hashing into the chain and the residency counts work unchanged:

| Session recording in force | Camera path |
|---|---|
| **Server** (`recording_mode` `server` or `both`, or a P4 policy `recordingRequired`, with an A.2 recorder joined) | the phone opens a **second** `sendonly` peer connection to the session's recorder, exactly as the P1 Desk does for its screen (A.2): the server sends the joined recorder `recorder.camera { sessionId, cameraId }` (new S→recorder message), the phone offers with `peer: 'recorder'`, `routeCameraRecorderWebrtc` relays between the camera socket and the recorder socket only, and the recorder writes a separate WebM and uploads it through `POST /api/v1/internal/recordings` with meta `source: 'camera', cameraId` (A.2 §9, additive). A recorder advertises the ability in `recorder.hello` (`features: ['camera']`, additive); when the session needs a server recording and its recorder lacks the feature, the camera link is refused with `409 camera_unrecordable` rather than run unrecorded |
| **Console** (`assist_only` or `both`, while the console's recording runs) | the console records the camera track with its own `MediaRecorder` into a separate recording uploaded through the existing multipart route with `source: 'camera'`; it starts and stops with the console's session recording |
| None | not recorded |

The phone learns the state in `camera.hello.ok.recording` (`{ server: boolean, console: boolean }`) **before** its consent screen and in `camera.state { recording }` afterwards; a recording that starts after the camera went live shows a "Recording" bar on the phone at once, and the phone holder can stop. The chain gains nothing new: the existing recording actions carry an optional `source` (`actions-a2.ts` and the A recording actions, additive). Snapshots stay as revision 1 bound them: saved in the technician's browser, chained by hash, never uploaded.

### 6.6 Console (binding; `CameraPanel` behind `<CameraSlot session sendChat tier>`)

The panel shows the link step (QR, link, code, expiry countdown, **Send to the Desk's chat**, **Cancel link**), then the live video in a resizable pane beside the Desk view, the camera code, the facing, **Freeze** (holds the last frame locally; the stream continues and a "Live" label returns on **Resume**), **Snapshot** (draws the current or frozen frame to a canvas, offers it as a PNG download named `camera-<session 8>-<YYYYMMDD-HHMMSS>.png`, and records `POST .../snapshots { sha256, width, height }`), and **Stop camera**. States are words ("Waiting for the phone", "Phone connected, waiting for consent", "Live", "Frozen", "Ended: the phone stopped"). Keyboard: every control reachable, the video has an `aria-label` naming it the phone camera.

### 6.7 REST (stream camera)

| Method / path | Roles | Request | Response and errors |
|---|---|---|---|
| `POST /api/v1/sessions/:id/camera-links` | the session's Assist | | `201 { cameraId, url, code, expiresAt }`; `403`, `404`, `409 bad_state`, `409 camera_busy`, `409 camera_unsupported`, `429`; chains `camera.link_created { cameraId, expiresAt }` |
| `DELETE /api/v1/sessions/:id/camera-links/:cameraId` | the session's Assist | | `204`; chains `camera.link_revoked { cameraId }` when still pending, otherwise ends the camera (`camera.ended { by: 'assist' }`) |
| `POST /api/v1/sessions/:id/camera/:cameraId/snapshots` | the session's Assist | `{ sha256: hex64, width: 1..8192, height: 1..8192 }` | `201`; `404`, `409 bad_state` (camera not live), `429`; chains `camera.snapshot { cameraId, sha256, width, height }` |

A camera join writes a `session_participant` row with role `camera` (`PARTICIPANT_ROLES` += `camera`), `label` `Phone camera`, no user id; the phone's user agent is never stored. Metrics: `ia_camera_sessions_total{tier,result}` (`live`, `declined`, `no_camera`, `expired`, `error`).

---

## 7. The mobile Assist console (stream mobile)

### 7.1 Scope (binding)

The existing console (`apps/web/src/assist/**`) becomes usable on Android and iPhone/iPad browsers and installable; no native controller app (W106). Input paths covered: **P1** (view and annotate; PRD 4 "Remote control of OS: No" for P1), **P3/P4 native Desks** (Windows, Linux X11 via `os.*` ops), **Android host Desks** (the same ops, mapped to gestures by `core/Gestures.kt`: a `button: 2` click is a 600 ms long press, `os.scroll` a swipe, `os.nav` back, home, recents). **P2** (the user's rule, W107 revised): in the `in_page` and `deep` input modes the replayer frame's existing capture (`RpPointer`, `RpWheel`, `RpKey` in `assist/console/mirror/replayerProtocol.ts`, turned into P2 control ops by `controlBuilders.ts`) receives the same gestures: tap = pointer down and up at the point, long press = a context-menu pointer event, two-finger drag = wheel deltas, the keys bar = `RpKey`; pinch zoom stays local; the tab actions stay buttons.

### 7.2 Gesture mapping (binding; `packages/shared/src/touch/gestures.ts`, a pure state machine over touch points and time)

Coordinates are normalised to the monitor's video rectangle **after** the view transform, so zoom never changes where an op lands.

| Gesture (thresholds in CSS px and ms) | P3/P4 and Android Desk (control granted) | P1 (annotation) | Any Desk without control |
|---|---|---|---|
| Tap (≤ 8 px movement, < 500 ms) | `os.pointer click` button 0 at the point | laser ping at the point | nothing |
| Double tap (two taps ≤ 300 ms apart, ≤ 24 px) | `os.pointer dblclick` | nothing | nothing |
| Long press (≥ 500 ms, ≤ 8 px) | `os.pointer click` **button 2** (right click; on an Android Desk this is its 600 ms long press) with a haptic tick (`navigator.vibrate(10)` where available) | nothing | nothing |
| One-finger drag (moved > 8 px within 150 ms of the press) | `down` button 0, `move` at most every 16 ms, `up` (a drag or an Android swipe) | draws with the selected annotation tool | pans the view when zoomed |
| Two-finger drag (finger distance changes < 15 %) | zoom = 1: `os.scroll` one notch per 40 px (dx, dy; inverted like a trackpad); zoom > 1: **pans the view, sends nothing** (the "Scroll" toggle in the toolbar switches two-finger drag back to `os.scroll` while zoomed) | pans when zoomed | pans when zoomed |
| Pinch (finger distance changes ≥ 15 %) | **zooms the view 1×–4× about the midpoint; sends no input** | same | same |
| Three-finger tap | toggles the on-screen keyboard | — | — |

A gesture that starts as one kind never turns into another (no scroll after a pinch was recognised). The **Trackpad** mode (toolbar toggle, default off on tablets and on on phones narrower than 600 px) moves a drawn cursor relatively (one-finger drag = `move` at the cursor, tap = click at the cursor), for precision on small screens. `InputOverlay` sets `touch-action: none`; pointer events with `pointerType: 'mouse' | 'pen'` keep today's behaviour exactly. Every op still goes through the existing controller paths, so `control.input` aggregation (C §3.8) and the refusal rules are unchanged.

### 7.3 On-screen keyboard (binding)

A focused, visually hidden `<textarea>` (`autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"`, `inputmode="text"`) raises the system keyboard; `beforeinput` `insertText` / `insertCompositionText` feed the existing `TextBuffer` (`os.text`), `deleteContentBackward` sends `os.key press Backspace`, `insertLineBreak` sends `Enter`. A special-keys bar above it: **Esc, Tab, Ctrl, Alt, Shift, Win/⌘ (sticky: one tap latches for the next key, a double tap locks), arrows, Home, End, PgUp, PgDn, Del, F1–F12 (expandable row), Paste** (`navigator.clipboard.readText()` on the tap, then `clipboard.set`, only when the Desk has `clipboard` and the user enabled it), **Ctrl+Alt+Del** (shown only when the Desk advertises `sas`; sends `os.sas`), and for an Android Desk **Back, Home, Recents** (`os.nav`). Keys go through `routeKey` and `os.key` as today. Every key is a `<button>` with an accessible name.

### 7.4 Layouts (binding)

| Width | Layout |
|---|---|
| < 600 px (phone portrait) | the Desk view full width at the top; a bottom tab bar (**View, Chat, Files, Keys, More**) switches a sheet below the view; the session header collapses to one line with the security-code state and **End** |
| < 600 px landscape, or `display-mode: standalone` in landscape | the view fills the screen; a floating toolbar that hides after 3 s without touch and returns on a tap at the top edge |
| ≥ 600 px and < 1024 px (tablet) | the view with a collapsible side panel (chat, files, playbooks, camera) |
| ≥ 1024 px | today's layout |

Touch targets are at least 44 × 44 CSS px; the page uses `viewport-fit=cover` and `env(safe-area-inset-*)`; text never below 14 px; the AppShell nav uses its existing menu button below `sm`. All Phase A–F console features remain reachable on every layout; nothing is hidden on phones except behind **More**.

### 7.5 Installable manifest (binding)

`apps/web/public/manifest.webmanifest` (`Content-Type: application/manifest+json`): `name` "IndiansAssist", `short_name` "Assist", `id` `/app/`, `start_url` `/app/` (it must lie inside `scope`: with `/app` the scope is invalid and browsers fall back to the scope derived from `start_url`, which is `/`, so the installed app would capture `/join`, `/room` and `/c` links), `scope` `/app/`, `display` `standalone`, `orientation` `any`, `background_color` and `theme_color` from the default theme, icons 192 and 512 PNG (`purpose: "any maskable"`) in `apps/web/public/icons/`. The `<link rel="manifest">` is **not** in the static `index.html`: `main.tsx` inserts it (and removes it on leaving) only while the route is under `/app`, so the phone's `/c` page, the Desk's `/join` and `/room` pages and the public pages are never installable as the console. `index.html` gains `<meta name="theme-color">`, `<link rel="apple-touch-icon">`, `<meta name="apple-mobile-web-app-capable" content="yes">` and `viewport-fit=cover`. Branding (B) does not change the manifest in Phase F.

### 7.6 Service worker: app shell only (binding; `apps/web/src/sw.ts` → `/sw.js`)

| # | Rule |
|---|---|
| 7.6a | Hand-written, no dependency (no Workbox; W121). Built by a small Vite plugin in `vite.config.ts` that emits `sw.js` with the build's hashed asset list and a build id; registered from `main.tsx` **only** in production builds and **only** on `/app` routes (`navigator.serviceWorker.register('/sw.js', { scope: '/' })`), so a Desk's browser never registers it |
| 7.6b | `install` precaches `/index.html`, the hashed `/assets/*` of this build, the manifest and the icons into `ia-shell-<buildId>`; `activate` deletes every other `ia-shell-*` cache |
| 7.6c | `fetch` handles **only** same-origin `GET`s: `/assets/*` cache-first; navigations whose path starts with `/app` network-first with a 4 s timeout, falling back to the cached `/index.html` (the app then shows "You are offline" and makes no call). **Everything else passes through untouched** (no `respondWith`): `/api/*`, `/signal`, `/download*`, `/.well-known/*`, `/replayer.html`, `/room*`, `/join*`, `/invite`, `/reset`, `/c*`, `/sso*`, every non-GET, every cross-origin request |
| 7.6d | It never caches a response that is not `200`, is opaque, or carries `Cache-Control: no-store`; it has no `push`, `sync`, `periodicsync` or `message` handler that touches data; signing out needs no cache clearing because no data is cached |
| 7.6e | `infra/nginx/web.conf` (F0): `location = /sw.js` and `location = /manifest.webmanifest` with `Cache-Control: no-cache` and the full security header set repeated (an `add_header` in a location replaces the inherited set), and the manifest MIME type. The CSP already allows `worker-src 'self'` and `manifest-src` falls back to `default-src 'self'` |

### 7.7 iOS and Android notes (binding)

iOS Safari has no element Fullscreen API on iPhone and no install prompt: the console shows "Add to Home Screen" guidance once on iOS in a browser tab, and the standalone app has its own cookie store, so the technician signs in once in it. Nothing changes for iOS as a Desk (share only, PRD 5). On Android Chrome the `beforeinstallprompt` event offers an **Install** button in the account page.

---

### 7.8 Give help in the Android app (binding; stream mobile, W128)

The Android host app (`apps/android`) gains a **Give help** entry on its start screen beside the existing join flow, so one app per platform both gets and gives help. It opens the mobile Assist console (`<origin>/app/`) in an **Android Custom Tab** (`androidx.browser`, Apache-2.0): the tab shares Chrome's cookies, so a technician signed in there stays signed in, and the installable console of §7.5 works unchanged. The origin is the app's compiled default (`BuildConfig.DEFAULT_API_ORIGIN`, the region origin list `BuildConfig.REGION_ORIGINS`), with a picker when several regions are compiled in; nothing else is configured. A Trusted Web Activity is **not** used: it needs a Digital Asset Links file on every self-hosted origin, and a Custom Tab needs nothing. No native controller UI is built. Without a Custom Tabs provider the app opens the default browser. Tests: a JVM unit test of the intent and origin choice, and one step in `apps/android/tools/android-e2e.mjs`'s run that taps **Give help** and checks Chrome opened `/app/` (the harness already installs the APK in the emulator). The host's chat makes a `${origin}/c/<code>` link tappable (§6.1).

## 8. Linux unattended for X11 (stream linux-p4)

### 8.1 Scope and architecture (binding)

The D architecture (D §1.4: service + bridge + desktop worker) on Linux. The service is `ia-service` built with a new feature `linux-service`, run by systemd as **root**, holding the device identity, the `/signal/device` socket, the policy, the action queue, the waker and the tamper outbox, exactly as D §3, §4.1, §6, §8.2, §9, §10 define them. It **never connects to an X server**. For each session it launches the worker `ia-desktop` (Linux build) **as the user of the active graphical session**, which runs the unchanged C serve loop with the E Linux capture, input and UI (E §7), holds its own `/signal` socket with the D worker credential, and asks the service to sign (D §4.2 `sign_sas`). Headless servers (no graphical session) still get device actions (D §9, `playbook_run` with `sh`, `file_push`, `message`), run by the service.

### 8.2 Crates and features (binding)

| Crate | Change |
|---|---|
| `ia-service` | feature `linux-service` = `dep:tokio`, `dep:tokio-tungstenite`, `dep:futures-util`, `dep:ureq`, `ia-platform/linux-os`, `ia-waker/net`, `dep:zbus` (the version already locked, 5.19.0, Linux-target only; system-bus client for logind and systemd); new modules under `src/linux/` (`runtime`, `logind`, `spawn`, `sdnotify`, `sealer`, `paths`, `facts`); `main.rs` gains the Linux entry (`--console` dev mode, `--deregister`, `--enroll <file>`, `--version`, `--help`); `SERVICE_NAME` on Linux `indiansassist-agent`; `user_agent()` says `Linux` |
| `ia-session0` | `src/unix.rs` (new): the D §4.2 transport over an **inherited socketpair** instead of a named pipe: the service creates `socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC)`, clears `CLOEXEC` on the child end, and passes it to the worker as **fd 3**; the worker's first act is `fcntl(3, F_SETFD, FD_CLOEXEC)`, so no process it spawns (an `sh` playbook, `xdg-open`) inherits the channel; the blob and frames (`blob.rs`, `proto.rs`) are unchanged. No path exists that another process could squat or connect to, so the C §7.2 pid / image checks reduce to the worker checking `getppid()` equals the pid in the blob and the service checking `SO_PEERCRED.pid` equals the child it spawned. `LaunchBlob` gains optional `linux: { display: string, sessionType: 'x11' \| 'wayland', uid: u32, xdgRuntimeDir: string }` |
| `ia-desktop` | builds on Linux: reads the blob from fd 3, sets up the Linux seams (E §7.2 crates, features `media`, `x11`, `gui`, `linux-os`), and on X11 discovers `XAUTHORITY` itself (§8.4c) |
| `ia-platform` | `src/linux/service.rs` (new): `ServiceHost` over `sd_notify` and the systemd D-Bus API (`query_state` and `start` for its own unit; `set_failure_actions` and `register_task` answer `Ok` because the unit file carries them; `task_exists` → `true`), `DesktopBridge` over logind (§8.4) and the spawn of §8.5; `Waker` reuses `ia-waker` (UDP broadcast; no raw socket); `Amt` reports `present: false` (no MEI access in Phase F) |
| `ia-watchdog` | not built on Linux: systemd `Restart=` and `WatchdogSec=` replace it (W110) |

### 8.3 Enrollment and identity on Linux (binding)

| # | Rule |
|---|---|
| 8.3a | Layout: binaries `/usr/lib/indiansassist/{ia-service,ia-desktop}`; state `/var/lib/indiansassist/` (0700 root; systemd `StateDirectory=indiansassist`); config drop `/etc/indiansassist/` (0750 root; `ConfigurationDirectory=`); runtime `/run/indiansassist/` (`RuntimeDirectory=`); logs to the journal (stdout/stderr) with the D redaction |
| 8.3b | **Keys at rest**: `device.key` and `device.kex` in the state directory, mode 0600 root, written atomically. There is no DPAPI equivalent on a generic Linux host; the `BlobSealer` is a `FileModeSealer` that stores the keys without OS sealing and **refuses to load** a key file whose mode or owner is wider than 0600 root (W109). The D §3.3 rule "never logged, exported or sent" is unchanged |
| 8.3c | Enrollment input: the signed `enroll.iaconfig` (D §12.3; minted by `GET /api/v1/devices/enroll-config`, unchanged) placed at `/etc/indiansassist/enroll.iaconfig` (mode 0600) by the administrator or the Ansible role, or given once as `ia-service --enroll <file>`. On start, an unenrolled service with that file runs the D §3.1 sequence, then overwrites the file with zeros and removes it (the D shred rule); an enrolled service ignores and removes a new file only after logging "already enrolled" (re-enrollment is the D §3.7 path) |
| 8.3d | `deviceMachineSchema.platform` accepts `'linux'` (was `z.literal('windows')`; `DEVICE_PLATFORMS` already has `linux` and `device.platform` exists, verified); `osVersion` = `PRETTY_NAME` (≤ 32); `hwFingerprint` = sha256 of `/etc/machine-id` with the D salt; `capabilities` per §8.7 |
| 8.3e | `device.hello.client` gains optional `os: 'windows' \| 'linux'` (absent = `windows`, so Phase D services are unaffected); `interactiveStateSchema` gains optional `display: 'x11' \| 'wayland' \| null` (Linux only) |

### 8.4 Session discovery and attach (binding)

| # | Rule |
|---|---|
| 8.4a | **Which session.** Over the **system bus** (`org.freedesktop.login1`): `Seat` `seat0` → `ActiveSession`; that session's `Type`, `Class`, `Active`, `Remote`, `State`, `Display`, `User`, `LockedHint`, `IdleHint`, `IdleSinceHint`. The target is that session only when `Class = 'user'`, `Remote = false`, `Active = true`. Signals `PropertiesChanged`, `SessionNew`, `SessionRemoved` and the seat's `ActiveSession` change trigger a re-evaluation (the D §5.3 rebuild path) |
| 8.4b | **Interactive state** (D §3.4) = `active` for a target X11 or Wayland session not locked; `locked` when `LockedHint` (the session stays the target, 8.4e); `none` for no target (a greeter session, `Class = 'greeter'`, a tty, nobody); `idleSec` from `IdleSinceHint`; `display` = the session `Type` (`x11`, `wayland`) or null. Remote (SSH, XRDP) sessions are never targets |
| 8.4c | **Display and authority.** `DISPLAY` = the session's `Display` property (for example `:0`). The service never reads another user's files or process environments. The worker, already running as the user (§8.5), finds its `XAUTHORITY` by reading the `environ` of **its own uid's** processes in the session's scope (`/sys/fs/cgroup/.../session-<id>.scope/cgroup.procs`, allowed for the same uid without privilege) for an `XAUTHORITY` paired with the same `DISPLAY`, then falls back to `$XDG_RUNTIME_DIR/gdm/Xauthority` and `~/.Xauthority`; it connects with `x11rb` using that cookie file. Failure → `ctl.event capture { path: 'none', cause: 'x11_lost' }` and the no-screen state |
| 8.4d | **Wayland user session**: no portal under the service (the portal needs a person to answer its dialog, and unattended means nobody may be there; W115). The worker starts in the E §7.4 no-screen mode (chat, files, playbooks as the user) |
| 8.4e | **Locked X11 session** (the user's decision, W126): the worker shares the locker's picture and **accepts input under the same consent and policy as an unlocked session**, so a technician with control can type the user's password into the locker through XTEST (an X11 locker reads XTEST key events like any keyboard). Nothing extra is granted: the D §6.2 table applies unchanged with D's own definition of present ("logged on and unlocked", `fleet/policy.ts`), so a locked session is "not present": an attended request answers `409 nobody_present`, and an unattended one proceeds only as the policy allows for nobody present (`auto_grant` under `allow`, as on a locked Windows device), and `control.input` is aggregated and chained as usual. The console shows "The Desk's screen is locked" while `LockedHint` is true. The greeter stays out of scope (8.4f) |
| 8.4f | **Greeter / nobody**: not supported (W108). `POST /api/v1/devices/:id/sessions` to a `linux` device whose last interactive state is `none` → `409 prelogin_unsupported` ("Nobody is signed in to this Linux computer. IndiansAssist can connect only to a signed-in desktop session."), whatever `allowLogonScreen` says |

### 8.5 Worker launch (binding)

The service spawns `/usr/lib/indiansassist/ia-desktop` and, in the child before `exec`, in exactly this order: `setsid()`; `setgroups` (the user's supplementary groups, from `getgrouplist`); `setgid` (primary gid); `setuid` (the uid; a failure of any of these aborts the child); `prctl(PR_SET_PDEATHSIG, SIGTERM)` **after** `setuid`, because a credential change clears the parent-death signal; then `getppid()` compared with the service pid captured before `fork`, exiting if they differ (the service died in between, so the death signal was never armed). After `exec` the worker re-checks `getppid()` against the blob's service pid (§8.2). It gets an **emptied environment** then exactly `HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH=/usr/local/bin:/usr/bin:/bin`, `LANG` (from the user's session when readable via logind, else `C.UTF-8`), `XDG_RUNTIME_DIR=/run/user/<uid>`, `DISPLAY` (X11) or nothing (Wayland, no-screen), `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus` when that socket exists (for the E `ksni` tray), the working directory `HOME`, fd 0 `/dev/null`, fds 1 and 2 to the journal, fd 3 the socketpair. **Capture and input run as the user, never as root.** The worker refuses to start as euid 0 (the E 7.3d rule) and when `getppid()` differs from the blob's service pid. **Dev `--console` mode** (`dev` feature only, never in a release build) runs the service as the current user with no uid change and takes `--runtime-dir <dir>` (used for the worker's `XDG_RUNTIME_DIR` instead of `/run/user/<uid>`), `--session-bus <address or none>` (instead of `/run/user/<uid>/bus`), `--system-bus <address>` (the logind fake) and `--display <:n>` (the harness display), so the WSL end-to-end run keeps the S3 isolation: no real runtime directory, session bus, system bus or WSLg display is ever named. The service kills the worker (SIGTERM, then SIGKILL after 5 s) at session end, on a session switch, and when it stops; supervision is the D §4.2 rule over `waitpid`.

### 8.6 Consent and presence (binding)

D §6.2 applies unchanged, with "present" = interactive state `active` (§8.4b). `local_consent` and `local_approval` show the C consent window and the D approval card in the user's X11 session; `auto_grant` shows the notice card and the pill. A device action's `playbook_run` with interpreter `sh` runs in the **service** as root (`ranAs: 'admin'`, the D label, with the E §7.8 runner rules: body on fd 3, stdin `/dev/null`, `IA_PARAM_*` env, process-group kill); session playbooks run in the worker as the user (`ranAs: 'user'`). Rule 9.9 and the receipts (D §6.4) are unchanged.

### 8.7 Capabilities (binding)

| Source | `capabilities` |
|---|---|
| Service (`ServiceCapabilities`, device row) | `{ monitors: <the count the last worker reported over fd 3 in a new `monitors` frame, else 1>, elevation: 'user', features: ['screen', 'multi_monitor' (always: the service never connects to X and cannot count monitors, and `fleet/worker.ts` refuses a worker whose features are not a subset of the device row's, so a two-monitor first session would otherwise hit `capability_mismatch`), 'input', 'input_text', 'clipboard', 'files', 'chat', 'playbooks', 'recorder', 'service_input', 'waker'], encoders: ['vp8', 'vp9'], hwEncoder: false, interpreters: ['sh'], serviceVersion }` — **no** `secure_desktop`, `sas`, `amt`, `amt_proxy`, `input_lock`, `privacy_screen`, `elevation`, `voice` |
| Worker on X11 | the E §7.5 X11 set; a subset of the service set above by construction. The worker sends `{ t: 'monitors', count }` to the service after each RandR change, and the service sends it in its next `device.hello` (a D §3.4 mutable fact; the count is informational and gates nothing) |
| Worker on Wayland | the E §7.5 Wayland set |

**Elevation (F6).** `serviceCapabilitiesSchema.elevation` is today `z.literal('admin')`; it becomes `z.enum(['admin', 'user'])` (F0), and a Linux service sends `'user'`: everything a technician does **in a session** runs as the signed-in user. The P4 "privileged mode" of D §4.3 / W32 (`fleet/session-hooks.ts` sets `consent_level = 'elevated'` and `elevation: 'admin'` because the Windows worker is LocalSystem) is not available on Linux: the worker answers `elevation.request` with `ctl.res { ok: false, error: 'not_supported' }` (the E 7.3d rule), and `fleet/session-hooks.ts` refuses a privileged-mode message from the worker of a `linux` device with `error bad_state` and writes no `elevation.granted`, so the console never shows a user-level worker as elevated. Device actions (§8.6) do run as root and keep reporting `ranAs: 'admin'`; that is a property of the action, shown on the action, not of the session.

### 8.8 The systemd unit (binding; `packaging/linux/indiansassist-agent.service`)

```ini
[Unit]
Description=IndiansAssist Agent
Documentation=https://<deployment>/docs
After=network-online.target systemd-logind.service
Wants=network-online.target

[Service]
Type=notify
ExecStart=/usr/lib/indiansassist/ia-service
Restart=on-failure
RestartSec=5
WatchdogSec=60
TimeoutStopSec=20
KillMode=mixed
UMask=0077
StateDirectory=indiansassist
StateDirectoryMode=0700
ConfigurationDirectory=indiansassist
ConfigurationDirectoryMode=0750
RuntimeDirectory=indiansassist
LockPersonality=yes
RestrictRealtime=yes
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
```

The service sends `READY=1` after enrollment state is loaded and `WATCHDOG=1` every 20 s from its main loop (a minimal `sd_notify` over `$NOTIFY_SOCKET`, no libsystemd). Hardening is deliberately light (W112): device-action playbooks run as root by design, and the worker must reach `/tmp/.X11-unix` and write the user's home, so `PrivateTmp`, `ProtectHome`, `ProtectSystem=strict`, `NoNewPrivileges` and a reduced capability bounding set are **not** used. `systemd-analyze verify` must pass; `systemd-analyze security --offline=yes` is run and its score recorded in §15.7, not gated. Tamper (D §10): `binary_changed` and `config_changed` from the D §10.3 integrity check at start and hourly against the package's installed file list and hashes; `watchdog_restarted` when the unit's `NRestarts` (read over the system bus at start) grew; `stopped` and `disabled` cannot be observed by a stopped service and are inferred by the server from heartbeat loss as today.

### 8.9 Packages (binding; `packaging/linux/`)

| Item | Binding |
|---|---|
| Formats | `.deb` (Debian, Ubuntu) and `.rpm` (RHEL-family, Fedora, SUSE) for x86_64, from the same two binaries |
| Build tools | **cargo-deb 3.8.0** and **cargo-generate-rpm 0.21.1** (both MIT, read from crates.io metadata on 2 Nov 2026; `cargo install <tool> --version <v> --locked` user-level in WSL is a **manual prerequisite**, like cargo-zigbuild in E §7.9; build tools, not shipped). Metadata in `[package.metadata.deb]` and `[package.metadata.generate-rpm]` of `ia-service/Cargo.toml`; both run with `--no-build` on the zigbuild release binaries |
| Binaries | the release build of E §7.9 (`cargo zigbuild --release --locked --target x86_64-unknown-linux-gnu.2.35`), now for `-p ia-service --features linux-service` and `-p ia-desktop` with the Linux features; `scripts/elf-check.mjs` gates both (NEEDED subset, `GLIBC_` ≤ 2.35); size ≤ 25 MiB each |
| Contents | `/usr/lib/indiansassist/ia-service`, `/usr/lib/indiansassist/ia-desktop` (0755 root), `/usr/lib/systemd/system/indiansassist-agent.service` (0644), `/usr/share/doc/indiansassist/copyright` (deb) or `%license` (rpm) naming `docs/LICENSE-REGISTER.md` |
| Dependencies | deb `Depends: libc6 (>= 2.35)`, `Recommends: systemd`; rpm `Requires: glibc >= 2.35`, `Recommends: systemd` (weak dependency); nothing else. systemd is not a hard dependency so the package installs in the offline T1 sandbox (whose Ubuntu Base root has no systemd and no network to fetch it) and in containers; on a host without systemd the service simply is not started (maintainer scripts below) (X11 is reached by `x11rb` over the socket; libX11, libxkbcommon and libGL are opened at run time by the worker's UI, E §7.9) |
| Maintainer scripts | `postinst` / `%post`: `systemctl daemon-reload` and `enable --now indiansassist-agent` **only when** `/run/systemd/system` exists (so they succeed in a container or chroot without systemd); `prerm` / `%preun` on removal: `ia-service --deregister` bounded to 10 s (the D `--msi-uninstall` signed deregister), **whose exit status is ignored** (`|| true`): an offline host, an unreachable api or an unenrolled device must never fail a removal or purge, and the server's heartbeat loss covers a device that could not say goodbye; then `systemctl disable --now` when `/run/systemd/system` exists; `postrm purge` / `%postun` on erase: remove `/var/lib/indiansassist` and `/etc/indiansassist`. No script downloads anything or touches the user's home |
| Signing | unsigned in Phase F; the sha256 of each package is published in the installer manifest and shown by the console (W111) |
| Names | `IndiansAssist-Agent-<version>-linux-x64.deb` / `.rpm` (`installerFileName(arch, version, format)`) |

### 8.10 Ansible role (binding; `packaging/linux/ansible/roles/indiansassist_agent/`)

| Path | Content |
|---|---|
| `meta/main.yml` | role metadata; `min_ansible_version: "2.16"`; platforms Ubuntu (jammy, noble), Debian (bookworm), EL (9), Fedora |
| `defaults/main.yml` | `indiansassist_state: present` (or `absent`), `indiansassist_package_url: ""` and `indiansassist_package_src: ""` (one of the two), `indiansassist_package_sha256: ""` (**required** when installing), `indiansassist_enroll_config: ""` (the iaconfig text; the role sets `no_log: true` on every task that touches it) |
| `tasks/main.yml` | assert the inputs; fetch with `ansible.builtin.get_url` and `checksum: sha256:<...>` or copy the local file; install with `ansible.builtin.apt` (`deb:`) or `ansible.builtin.dnf` (local path, `disable_gpg_check: true` because the package is unsigned, W111); place `/etc/indiansassist/enroll.iaconfig` (0600) **only when** `/var/lib/indiansassist/device.key` does not exist; ensure `indiansassist-agent` enabled and started; for `absent`: run `ia-service --deregister`, remove the package |
| `handlers/main.yml` | restart on package change |

Idempotent (a second run changes nothing); `ansible-lint` with the `production` profile clean.

### 8.11 api and web changes (binding)

`installerBuildSchema` gains optional `platform: 'windows' | 'linux'` (default `windows`) and `format: 'msi' | 'deb' | 'rpm'` (default `msi`); `GET /api/v1/download/installer` lists them; `GET|HEAD /api/v1/download/installer/:arch?tokenId=&format=deb|rpm` serves Linux packages (`Content-Type: application/vnd.debian.binary-package` or `application/x-rpm`; everything else as the MSI route, including `download.served { ..., platform: 'linux', format }`). `EnrollDeployDialog` gains a **Linux** tab: download deb or rpm with sha256, the enroll config download, and a copyable Ansible snippet and `sudo` commands (`sudo install -m 0600 enroll.iaconfig /etc/indiansassist/ && sudo apt install ./IndiansAssist-Agent-<v>-linux-x64.deb`). The device page shows the platform and, for Linux, the display type ("Signed-in X11 session", "Wayland session: chat and files only", "Nobody signed in: device actions only").

### 8.12 Tests and the throwaway environments (binding)

| Layer | Runs on | Covers |
|---|---|---|
| Pure | every host | logind facts → target and interactive state (table); XAUTHORITY discovery over a fake `/proc` and cgroup tree in a temp dir; the spawn plan (uid, gid, env list, fds) as data, including the §8.5 call order (a test asserts `PR_SET_PDEATHSIG` comes after `setuid` and the `getppid` check after it) and `FD_CLOEXEC` set on fd 3 by the worker; the service capabilities always containing `multi_monitor` and `elevation: 'user'`; the socketpair handshake with `getppid` and `SO_PEERCRED` decisions; capabilities; `FileModeSealer` mode checks; the unit file and maintainer scripts as text (content assertions); the Ansible role YAML parsed with structural assertions |
| Linux, no root | WSL (the E §15.6 commands, now including `ia-service --features linux-service` and `ia-desktop`) | a **fake logind** on a **private system-bus stand-in** (`agent/scripts/logind-fake.sh` starts `dbus-daemon --config-file=<tmp conf> --address=unix:path=$T/system_bus` and a zbus-served `org.freedesktop.login1` test object; the service under test gets `DBUS_SYSTEM_BUS_ADDRESS` pointing at it, never the real system bus); the service in `--console` dev mode as the **current user** enrolling against a test api; the worker spawned as the same uid (no uid change needed) onto the harness Xvfb `:97`; the socketpair transport end to end; `sh` device actions (read-only playbooks) |
| Package checks | WSL, read-only on the files | `systemd-analyze verify packaging/linux/indiansassist-agent.service` (with the binary path mapped to a temp copy); `dpkg-deb --info` and `--contents` on the built deb; `rpm -qpl --scripts --requires` on the rpm (needs the `rpm` tool, below); file modes and owners; `scripts/elf-check.mjs` on the binaries; `ansible-playbook --syntax-check` and `ansible-lint --profile production` on a test playbook using the role (needs `ansible-core` and `ansible-lint`, below) |
| **T1 sandbox install** (default gate) | WSL, `agent/scripts/pkg-sandbox-test.sh` | an **Ubuntu Base 22.04** root file system (the official `ubuntu-base-22.04.*-base-amd64.tar.gz` from `cdimage.ubuntu.com`, the file name and sha256 pinned by the stream and checked against the published `SHA256SUMS`; downloaded once into `~/.cache/ia-throwaway/` in WSL) extracted into a fresh temp directory and entered with **bubblewrap as a fake root** (`bwrap --unshare-all --uid 0 --gid 0 --bind <rootfs> / --proc /proc --dev /dev --tmpfs /tmp --die-with-parent`; no network inside): `dpkg -i` the deb (it depends only on `libc6`, present in Ubuntu Base, so no `--force-depends` is needed), assert the files, modes, unit and that `postinst` skipped systemd, run `ia-service --version` (proving the glibc 2.35 floor), `dpkg --purge` (the `prerm` deregister fails offline and must not stop it), assert nothing remains; then delete the temp directory. Nothing outside the temp directory and the download cache changes; prerequisites `bwrap` and unprivileged user namespaces, both present on 2 Nov 2026 |
| **T2 disposable WSL distro** (opt-in, never a default gate) | Windows, `IA_THROWAWAY_WSL=1 pnpm linux:throwaway` (`agent/scripts/throwaway-wsl.ps1`) | imports a distro named `IA-Throwaway-<8 hex>` from Ubuntu's official 24.04 WSL image (sha256 checked) into a temp directory, enables systemd in its `/etc/wsl.conf`, installs the deb, enrolls against a Windows-hosted test api (port 4160, the WSL gateway as in E §7.10), checks the unit is active, kills the service and checks `Restart=` brought it back with a `watchdog_restarted` tamper event, runs one read-only device action, purges, then **always** `wsl --terminate` and `wsl --unregister` in a `finally`. It refuses a name not matching `^IA-Throwaway-[0-9a-f]{8}$`, refuses when that name exists, and never touches the `Ubuntu` distro. Prerequisites stated honestly: the user's explicit run, network (about 400 MB), about 3 GB of disk, WSL with `--import` (WSL 3.0.3 present). It registers a WSL distro for its duration, which is why it is opt-in |
| Manual | a disposable real machine | install on Ubuntu 22.04 or 24.04 with an Xorg session and on an EL 9 or Fedora Xorg session; enrollment; an unattended session with input on a real X server and window manager; a locked session; a Wayland session (no screen); reboot; the Ansible role against it; removal and purge. Listed in `docs/release.md` |
| End to end | Windows Playwright + WSL | `pnpm e2e:p4:linux` (`apps/web/e2e/run-p4-linux.mjs`, api on `0.0.0.0:4160`, web 5330, data `./data/e2e-linux-p4`): the dev service in `--console` mode as the current user with the fake logind reporting an X11 session on the harness Xvfb `:97`, enrollment with a token from the test org, an attended session and an unattended `auto_grant` session (synthetic and X11 cases), a click read back with `xdotool` on `:97`, chat, a file, a read-only `sh` playbook in the session and as a device action, the Wayland case (no screen), the `none` case (`409 prelogin_unsupported`), the audit chain |

**One-time WSL installs for linux-p4** (the user runs them; no test does): `sudo apt install --no-install-recommends rpm ansible-core ansible-lint` (available on 2 Nov 2026: rpm 6.0.1, ansible-core 2.20.1, ansible-lint 26.1.1), and user-level `cargo install cargo-deb --version 3.8.0 --locked` and `cargo install cargo-generate-rpm --version 0.21.1 --locked`. Without them the rpm-content, Ansible-lint and package-build gates are reported **not met**, not skipped silently.

### 8.13 Out of scope (linux-p4)

The greeter and pre-login access (W108); screen sharing of a Wayland user session by the service (W115); `secure_desktop`, `sas`, input lock and privacy screen equivalents; AMT inventory and proxy on Linux; arm64; signed packages and repositories (W111); SELinux and AppArmor policy modules (the unit runs unconfined, as packages commonly do; recorded in `docs/release.md`).

---

## 9. The Wayland portal build (stream wayland)

### 9.1 Scope (binding)

A **second Linux binary, shipped in the same download** as the X11 binary (the user's decision, W127): the portable P3 agent built with the new `portal` feature, which on a Wayland session captures through **xdg-desktop-portal ScreenCast** with frames from **PipeWire**, and offers **view, chat, files, playbooks and the recorder; no input and no clipboard** (W113, W114). On an X11 session the portal build behaves exactly like the X11 build (it contains the X11 path too). It is a P3 portable agent only; the service never uses it (§8.4d).

### 9.2 Crates and features (binding)

| Item | Binding |
|---|---|
| `ia-capture-portal` (new) | implements `ia_platform::Capturer`. Pure part (every host): the portal session state machine as data, SPA format negotiation, stride and format conversion to BGRA, the `capture` cause mapping. OS part behind `cfg(target_os = "linux")` and feature `portal`: **ashpd 0.13.13** (MIT; features `screencast` and `tokio`, `default-features = false`; it uses zbus `^5.13`, satisfied by the locked 5.19.0) for `CreateSession`, `SelectSources { types: MONITOR, multiple: false, cursor_mode: EMBEDDED when offered else HIDDEN, persist_mode: DO_NOT_PERSIST }`, `Start`, `OpenPipeWireRemote`; **pipewire 0.10.1** (MIT, with `libspa` 0.10.1; links `libpipewire-0.3`, bindgen at build time) consuming the stream from the portal's fd and node id. Accepted buffers: `MemFd` and `MemPtr` with `BGRx`, `BGRA`, `RGBx`, `RGBA`, `xRGB`; **DMA-BUF is not negotiated** in Phase F. Dependencies only under `[target.'cfg(target_os = "linux")'.dependencies]`, so the Windows `--all-features` gates compile nothing for it (E §7.4) |
| `ia-agent` | feature `portal` = `media`, `x11`, `gui`, `linux-os`, `dep:ia-capture-portal`, `ia-ui/wayland`; `pump.rs` `CaptureSource` gains `Portal(..)` under `cfg(all(target_os = "linux", feature = "portal"))`; `desk.rs` advertises §9.4 |
| `ia-ui` | feature `wayland` enables eframe's Wayland backend (winit with `wayland-dlopen`, libwayland opened at run time, nothing linked), so the consent window, pill and panel show on Wayland without XWayland (closing that E §7.4 limitation for this build only). On Wayland the pill cannot be kept above other windows (no protocol for it); the compositor's own screencast indicator (shown by GNOME and KDE for any portal session) is the persistent indicator, and the pill is a normal window |
| `ia-core` | `types.rs`: `LINUX_PORTAL_FEATURES`; `capture_decision`: the causes of §9.3 |
| shared | `CAPTURE_PATHS` += `portal`; `CAPTURE_CAUSES` += `portal_denied`, `portal_closed`; `agentBuildSchema` gains optional `companion: { sha256, size }` (Linux only: the portal binary shipped beside the main one); `downloadPrepareSchema` is **unchanged** (no variant: one Linux download); `agentDistFileName('linux', 'x64', v)` stays the X11 ELF and `agentPortalDistFileName(v)` = `IndiansAssist-linux-portal-x64-<v>` names its companion in `AGENT_DIST_DIR` |

### 9.3 Capture behaviour (binding)

After the agent's own consent (C §3.3), the portal shows the compositor's source dialog (the per-session portal consent; never persisted, so every session asks). Cancelled → `ctl.event capture { monitorId: 1, path: 'none', cause: 'portal_denied' }` and the no-screen state; started → `capture { path: 'portal', cause: 'start' }`; the user stops sharing from the compositor ("Stop sharing" in GNOME) or the stream ends → `cause: 'portal_closed'` and the no-screen state for the rest of the session (re-asking is not automatic; the console says "The user stopped screen sharing"). `next_frame` follows the E rule (the last frame again when nothing changed). The portal reports one stream → `monitors: 1`.

### 9.4 Capabilities and the console (binding)

| Session | Portal build `capabilities` |
|---|---|
| Wayland, portal available | `{ monitors: 1, elevation: 'user', features: ['screen', 'files', 'chat', 'playbooks', 'recorder'], encoders: ['vp8', 'vp9'], hwEncoder: false, interpreters: ['sh'] }` |
| Wayland, no portal on the session bus or no ScreenCast interface | the E §7.5 Wayland set (no `screen`), `capture { path: 'none', cause: 'wayland_unsupported' }` |
| X11 | the E §7.5 X11 set |

The console needs no new code for the view-only case: `controlBlocker` already says "This Desk cannot take remote control" when `input` is absent and `ClipboardToggle` explains a missing `clipboard` (E §7.4, coordinator).

### 9.5 Download and join page (binding)

**One Linux download** (the user's decision, W127). The per-download `.tar.gz` (E §7.6) now holds **two** files: the X11 binary under the per-download name `IndiansAssist-<region>-<dddd>-<dddd>-<dddd>` (the filename carrier, unchanged, so `ia_core::download` needs no change) and the portal binary as `.ia-portal` beside it (mode 0755; a dot name so a file manager shows one program, and a name that the E filename regex never matches). Construction stays a pure function of the grant: gzip member 1 = the ustar header of the main file (per request), member 2 = the X11 binary padded (cached), member 3 = the fixed ustar header of `.ia-portal` (cached), member 4 = the portal binary padded plus the two zero blocks (cached); `Content-Length`, `Range` and `HEAD` work as before. When `AGENT_DIST_DIR` has no portal companion, members 3–4 are omitted and the download is today's archive.

**Hand-over on Wayland.** The X11 binary resolves its token from its carriers first (E §7.6), then runs `display_server()` (E §7.4). On `Wayland`, if `.ia-portal` exists beside it, is a regular file owned by the user, has the sha256 its own build embeds for the companion (a release build records the companion's hash at link time from the dist manifest; a dev build skips the check and logs it), and `dlopen("libpipewire-0.3.so.0", RTLD_NOW)` succeeds, it `execve`s `.ia-portal` with the same arguments plus `--handed-from <own path>`, passing the already-resolved token on an inherited pipe (fd 4, never in argv or the environment), so the filename and clipboard carriers are not consulted twice. Otherwise it stays and shows E §7.4's honest Wayland message, adding "Screen sharing on Wayland needs PipeWire, which was not found." when only the library is missing. Self-delete (E §7.7) and Keep (§3.4) treat the pair as one program: whichever binary runs at exit removes (or keeps) both files and the archive. The join page offers a **single** button, **Download for Linux (x86-64)**, with the line "Works on X11 and Wayland desktops. On Wayland the technician can see your screen but cannot control it." and the extraction command of E §7.6; the sha256 printed is the X11 binary's, with the companion's on a second line. `download.served` gains optional `companion: boolean`.

### 9.6 Build, release and tests (binding)

| Item | Binding |
|---|---|
| Dev build | in WSL: `cargo build -p ia-agent --no-default-features --features ia-agent/portal,ia-agent/dev` (needs the packages below) |
| Release | `LIBVPX_TARGET=ubuntu-22.04_x86_64 cargo zigbuild --release --locked --target x86_64-unknown-linux-gnu.2.35 -p ia-agent --no-default-features --features portal`. **The glibc floor of this artefact is measured, not asserted**: `scripts/elf-check.mjs` gains a `--allow libpipewire-0.3.so.0` option and the gate is NEEDED ⊆ the E set ∪ {`libpipewire-0.3.so.0`} and `GLIBC_` ≤ 2.35. If zigbuild cannot link libpipewire against the 2.35 floor, the stream records the failure, builds with plain `cargo build --release` on the build host instead, and records the resulting floor as an open item (W113); it does not ship an artefact whose floor it has not measured. The minimum PipeWire and portal versions a Desk needs are recorded from the binding versions actually linked |
| Headless test stack | `agent/scripts/portal-test.sh` (wayland) starts, all under a fresh temp `XDG_RUNTIME_DIR` (0700) and temp `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME`, with `DISPLAY` and the WSLg `WAYLAND_DISPLAY` unset: a **private session bus** (`dbus-daemon --session --address=unix:path=$T/bus --nofork`), **sway** headless (`WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1`, its own `WAYLAND_DISPLAY=ia-wl-<rand>`, a config with output `HEADLESS-1` at 1280×720 and a solid known background colour via `swaybg`), **pipewire** and **wireplumber** on that runtime dir, and `xdg-desktop-portal` with `xdg-desktop-portal-wlr` configured `chooser_type=none` and `output_name=HEADLESS-1` and `portals.conf` `default=wlr` (`XDG_CURRENT_DESKTOP=sway`). It then runs the `#[ignore]` portal tests with `--ignored`: a session started without a dialog, frames received with the known colour, `portal_closed` when the stream is stopped, `portal_denied` when the portal is configured to cancel. Guard: a portal test refuses to run unless `IA_TEST_PORTAL_BUS` equals the harness bus address and `WAYLAND_DISPLAY` starts with `ia-wl-`. On exit the script stops every process it started and deletes the temp root. If sway cannot start headless in WSL, the gate is reported **not met**; there is no fallback compositor (weston implements no wlroots screencopy, and the GNOME portal needs gnome-shell's chooser) |
| End to end | `pnpm e2e:p3:linux` gains a fourth case: the **X11 dev binary with `.ia-portal` beside it**, started under the stack above, hands over to the portal binary (asserted in its log and by the process image) and joins a `p3_portable` session; a fifth case runs the pair with `IA_TEST_NO_PIPEWIRE=1` (honoured only by dev builds: it makes the `dlopen` check fail) and expects the X11 binary to stay with the honest message; in the fourth case the console shows video of the known colour, Control greyed with E's text, chat and a file work |
| Windows gates | unchanged and green (`--all-features` enables `portal`, which compiles nothing on Windows) |

**One-time WSL install for wayland** (the user runs it; no test does): `sudo apt install --no-install-recommends sway swaybg xdg-desktop-portal xdg-desktop-portal-wlr pipewire pipewire-bin wireplumber libpipewire-0.3-dev libspa-0.2-dev clang libclang-dev` (all available on 2 Nov 2026 in Ubuntu 26.04.1: sway 1.11, swaybg 1.2.1, xdg-desktop-portal 1.21.1, xdg-desktop-portal-wlr 0.8.1, pipewire 1.6.2, wireplumber 0.5.13, clang 21). `--no-install-recommends` keeps out `slurp` and friends. Side effects the user should know: the pipewire and wireplumber packages add per-user socket-activated units and xdg-desktop-portal becomes D-Bus-activatable on the user's own session bus in the main distro; the harness never uses either (it runs its own on a temp runtime directory and private bus), and they start only when something on the user's session asks for them.

---

## 10. Libraries and the licence register (binding)

Crate licences and versions were read from crates.io metadata on 2 Nov 2026 (no personal data in the requests); each stream confirms the licence from the crate's manifest in its local Cargo registry when it adds the crate. F0 adds every row with status **"planned, Phase F <stream>"**; the stream that adds the dependency flips its row in the same change.

| Component | Licence | Use | Stream |
|---|---|---|---|
| zbus 5.19.0 (already locked through ksni; becomes a direct Linux-target dependency of `ia-service`) | MIT | logind and systemd over the system bus (§8.4, §8.8) | linux-p4 (existing row amended) |
| cargo-deb 3.8.0 | MIT | builds the `.deb` (§8.9); **build tool, not shipped** | linux-p4 |
| cargo-generate-rpm 0.21.1 | MIT | builds the `.rpm` (§8.9); **build tool, not shipped** | linux-p4 |
| Ubuntu Base 22.04 root file system | various free licences (Ubuntu) | the T1 sandbox install test (§8.12); **test only, not shipped** | linux-p4 |
| rpm, ansible-core, ansible-lint (WSL system packages) | LGPL-2.1+/GPL-2.0+ (rpm), GPL-3.0+ (ansible-core), MIT (ansible-lint) | read-only package inspection and role linting (§8.12); **test tools on the build host, not shipped, nothing linked or copied** | linux-p4 |
| ashpd 0.13.13 (existing "planned" row pinned) | MIT | the portal ScreenCast client (§9.2), Linux-target only | wayland |
| pipewire 0.10.1 + libspa 0.10.1 (+ `pipewire-sys`, `libspa-sys`; build-time bindgen and clang-sys, licences confirmed from their manifests at install) | MIT (pipewire, libspa) | PipeWire stream consumer (§9.2); links libpipewire-0.3 (MIT) at run time on the Desk | wayland |
| eframe `wayland` feature families (winit Wayland backend, smithay-client-toolkit, wayland-client, wayland-protocols, wayland-backend; licences confirmed from their manifests at install) | MIT (expected; confirmed at install) | the consent window and pill on Wayland in the portal build (§9.2) | wayland |
| sway, swaybg, pipewire, wireplumber, xdg-desktop-portal, xdg-desktop-portal-wlr, clang (WSL system packages) | MIT, MIT, MIT, MIT, LGPL-2.1+, MIT, Apache-2.0 with LLVM exception | the headless portal test stack and the build (§9.6); **test and build tools, not shipped** | wayland |

| qrcode (Rust crate) 0.14.1 | MIT OR Apache-2.0 (crates.io, 2 Nov 2026) | the camera-link QR in the Windows and Linux agents' chat (§6.1) | linux-p4 |
| androidx.browser (Custom Tabs; version pinned at install) | Apache-2.0 | **Give help** in the Android app (§7.8) | mobile |
| objc2, objc2-foundation, objc2-app-kit, objc2-screen-capture-kit, objc2-core-graphics, block2 (versions pinned at install, licences confirmed from their manifests) | MIT (expected) | macOS frameworks from Rust (§17.2), macOS-target only | apple |
| Google WebRTC for iOS (a pinned binary xcframework through Swift Package Manager, version and checksum recorded at install) | BSD-3-Clause | the iOS broadcast extension's peer (§17.4) | apple |
| Xcode, `pkgbuild`, `productbuild`, `codesign`, `notarytool` (Apple developer tools on the Mac) | Apple's Xcode licence | building, signing and packaging (§17); **build tools, not shipped** | apple |

Rejected: any Workbox or PWA plugin (a hand-written app-shell worker is ~150 lines; W121), `smtp-server` (a `node:net` fake suffices; no package added), `nix` (`libc` already covers the Linux calls), GStreamer `pipewiresrc` (a far larger dependency than pipewire-rs). No AGPL component is added.

---

## 11. Environment and infrastructure (`apps/api/src/config.ts`, `infra/`)

| Variable | Default | Rule |
|---|---|---|
| `FLEET_DATA_KEYS_PREVIOUS` | `` | comma list of `<keyId>:<64 hex>`, open-only (§3.1c) |
| `SMTP_REQUIRE_TLS` | `true` in production, else `false` | §4.1b |
| `ERASURE_DEV_COOLING_OFF_SEC` | unset | development only; a positive integer replaces the 7-day cooling-off; set with `NODE_ENV=production` is a boot problem (§5.2c) |
| `BACKUP_RETENTION_DAYS` | `` | the operator's database and object-store backup retention, stated in the erasure certificate and the residency report (`''` = "not stated") |
| `E2E_API_PORT`, `E2E_WEB_PORT`, `E2E_DATA_DIR`, `E2E_SMTP_PORT` (harness only) | per §1.5 | never 4000, 4100, 4105 |

Existing keys newly passed by compose and documented in `infra/.env.example`: §3.1a. `Permissions-Policy` **stays `camera=()`** in `infra/nginx/security-headers.conf` and in the `/replayer.html` location (which must not widen). Only the phone page's locations, `location = /c` and `location ^~ /c/` in `web.conf`, send `camera=(self), geolocation=(), display-capture=(), microphone=()` (the phone page needs the camera and nothing else) with the rest of the security header set repeated; `scripts/infra/configs.mjs` expects exactly that (W116; amends A's P3 header row for those two locations only). `web.conf` gains the `/c/` (§6.2e), `/sw.js` and `/manifest.webmanifest` (§7.6e) locations and the reset routes in the auth rate-limit location (§4.4). `pnpm validate:infra` checks all of it, plus the parity rule of §3.1b. The Compose stack adds no service.

---

## 12. Non-functional targets (PRD 13)

| Area | Target and rule |
|---|---|
| Metrics | zero-initialised at boot (D §13.5 rule): `ia_mail_sent_total{kind,result}`, `ia_password_resets_total{result}` (`mailed`, `sso_notice`, `throttled`, `send_failed`, `no_mailer`, `unknown`, `confirmed`, `invalid`), `ia_erasures_total{state}` (terminal transitions), `ia_camera_sessions_total{tier,result}`; F0 registers them in `lib/metrics.ts`, streams increment |
| Latency | the reset request answers in under 50 ms of api time regardless of the account (work after the reply); a camera's first frame reaches the Assist within 5 s of **Start camera** on a LAN; a touch op leaves the console within one animation frame of the gesture's recognition |
| Erasure | an org of 1,000 users, 100,000 sessions and 1,000,000 chain entries completes steps 1–8 within 30 minutes on one node; steps run in batches of 1,000 rows so no transaction holds locks for more than 5 s |
| Accessibility | the reset, users, erasure, camera (console and phone) and mobile console surfaces meet WCAG 2.1 AA: keyboard-operable, states in words, live regions for state changes, touch targets ≥ 44 px on the mobile layouts; one keyboard-only Playwright spec per web stream (`f-mail`, `f-erasure`, `f-camera`), and the mobile spec checks target sizes |
| Logs | the §14 redact paths; reset tokens, invite secrets, camera codes, resume keys, enroll configs and mail bodies never logged |

---

## 13. Shared, DB and console additions

### 13.1 Shared (`packages/shared`, name index)

| File | Exports |
|---|---|
| `enums-f.ts` (new; `export *` from `enums.ts`) | `MAIL_KINDS`, `RESET_OUTCOMES`, `ERASURE_STATES` (`pending_confirmation`, `pending_approval`, `cooling_off`, `executing`, `completed`, `cancelled`, `expired`), `ERASURE_STEPS` (`freeze`, `stop`, `chain`, `objects`, `rows`, `seal`, `verify`, `certify`, `notify`), `CAMERA_STOP_REASONS` (`declined`, `phone_stopped`, `assist`, `session_ended`, `link_expired`, `disconnected`, `no_camera`, `permission_denied`, `error`), `CAMERA_FACINGS`, `INSTALLER_FORMATS` (`msi`, `deb`, `rpm`), `LINUX_DISPLAY_TYPES` (`x11`, `wayland`), each with its singular type |
| `enums.ts` (additive) | `PARTICIPANT_ROLES` += `camera`; `SESSION_END_REASONS` += `org_erased`; `WEBRTC_PEERS` += `camera`; `LIMITS` += `passwordResetTtlMin: 30`, `passwordResetPerHour: 3`, `erasureApprovalTtlDays: 7`, `erasureCoolingOffDays: 7`, `erasureReauthMin: 15`, `erasureApproverMinDays: 7`, `erasureSoloCoolingOffDays: 14`, `erasureConfirmTtlHours: 24`, `erasureBatchRows: 1000`, `cameraLinkTtlSec: 600`, `cameraPerSession: 1`, `cameraResumeSec: 60`, `cameraMaxBitrateKbps: 1500`, `cameraSnapshotsPerMinute: 10`; `export * from './enums-f.js'` |
| `enums-p3.ts` (additive) | `CAPTURE_PATHS` += `portal` |
| `errors.ts` (additive) | the §2.4 REST codes; `SIGNAL_ERROR_CODES` += `camera_link_invalid`, `camera_busy` |
| `agent/control.ts` (additive) | `CAPTURE_CAUSES` += `portal_denied`, `portal_closed`; control event kinds += `keep` (`ev('keep', { kept: z.boolean() })`) |
| `agent/download.ts` (additive) | `companion` on `agentBuildSchema` (Linux only); `agentPortalDistFileName(v)`; `downloadPrepareSchema` unchanged |
| `fleet/device.ts` (additive) | `deviceMachineSchema.platform` `z.enum(['windows', 'linux'])`; `interactiveStateSchema.display` optional |
| `schemas/signal-device.ts` (additive) | `deviceHelloClientSchema.os` optional |
| `fleet/installer.ts` (additive) | `installerBuildSchema.platform`, `.format` optional; `installerFileName(arch, v, format = 'msi')`; `installerDownloadQuerySchema.format` optional |
| `schemas/signal-camera.ts` (new) | the §6.4 message schemas, `CAMERA_CLIENT_TYPES`; joined into `clientSignalMessageSchema` and `serverSignalMessageSchema` by `schemas/signal.ts` |
| `schemas/rest-mail.ts` (new) | `authOptionsSchema`, `passwordResetRequestSchema`, `passwordResetConfirmSchema`, `inviteResendReplySchema`; `inviteRequestSchema` (`rest-core.ts`) gains `sendEmail`, `inviteResponseSchema` gains `mailed` |
| `schemas/rest-erasure.ts` (new) | `orgErasureSchema` / `OrgErasure`, `erasureRequestSchema`, `erasureApproveSchema`, `erasureReplySchema`, `chainDigestPageSchema` |
| `erasure/certificate.ts` (new) | `erasureCertificateSchema`, `ERASURE_SIG_DOMAIN` (`ia-erasure-v1`), `erasureSigningInput`, `signErasureCertificate(cert, seedHex, kid)`, `verifyErasureCertificate(raw, keys)` |
| `schemas/rest-camera.ts` (new) | `cameraLinkReplySchema`, `cameraSnapshotRequestSchema`, `cameraCode` helpers (`normaliseCameraCode`, `formatCameraCode`, `CAMERA_CODE_RE`), `cameraSecurityCode(offerFpr, answerFpr, nA, nP)`, `cameraCommit(nA)` and the `ia.cam` frame schemas (§6.5) |
| `touch/gestures.ts` (new) | `TouchSample`, `GestureEvent`, `GestureConfig` (the §7.2 thresholds), `createGestureRecognizer(config, mode)` (F0 types; mobile behaviour), `mapGestureToOps(gesture, desk)` |
| `schemas/rest-residency.ts` | `erasure` widened and extended (§5.7; the one non-additive change) |
| `audit/actions-f.ts` (new) | `F_AUDIT_ACTIONS`, `F_CHAIN_SCHEMAS`, `F_ACTION_ACTORS` |
| `audit/actions-p3.ts` (additive) | `download.served` gains optional `companion` (boolean) and `format` |
| `enterprise/integrations.ts` (additive) | `INTEGRATION_VERIFICATION` |

Cross-language fixtures (new): `packages/shared/test/fixtures/erasure/certificate-signature.json`; `fixtures/touch/gestures.json` (sample sequences → expected ops, replayed by `packages/shared/test/touch-gestures.test.ts`); `fixtures/agent/agent-names.json` gains `portal`, `portal_denied`, `portal_closed` and the `keep` event (regenerated by `scripts/gen-agent-fixtures.mjs`, mirrored by `ia_core`).

### 13.2 Database (`packages/db`, migration `0009_phase_f`)

| Change | Detail |
|---|---|
| pgEnums | `participant_role` add `camera`; `session_end_reason` add `org_erased`; `playbook_interpreter` add `zsh` (it follows `PLAYBOOK_INTERPRETERS`, §17.8) (`ALTER TYPE ... ADD VALUE`; nothing in `0009_phase_f` refers to a new value, the E 12.1 rule); new `erasure_state` (the §13.1 values) |
| `org` | `audit_pepper` **drops NOT NULL**; add `erasing_at` timestamptz null, `erased_at` timestamptz null; check `org_pepper_erased` `(audit_pepper is null) = (erased_at is not null)` |
| `recording` | add `source` text not null default `'desk'` (check `source in ('desk','camera')`), `camera_id` uuid null (§6.5a), check `recording_camera_id_present` `(source = 'camera') = (camera_id is not null)`; `recording_session_source_unique` widened from `(session_id, recorded_by)` to `(session_id, recorded_by, camera_id) NULLS NOT DISTINCT`, else a recorder could not store a camera recording beside the session's (F0, §16.3 F0-2) |
| `user` | add `invite_mailed_at` timestamptz null; `role_since` timestamptz not null (added with default `now()`, then backfilled `= created_at` in the same migration); `role_granted_by` uuid null fk user (null for existing rows: no history is invented) |
| `password_reset` (new) | `id` uuid pk, `user_id` fk user on delete cascade (index), `token_hash` char(64) not null unique, `expires_at` timestamptz not null, `used_at` timestamptz null, `superseded` boolean not null default false, `created_at` |
| `org_erasure` (new) | `id` pk, `org_id` fk org (index), `state` erasure_state not null, `solo` boolean not null default false, `confirm_token_hash` char(64) null, `confirm_expires_at` timestamptz null, `reason` text null (scrubbed at step 5), `requested_by` fk user, `requested_at`, `approved_by` fk user null, `approved_at` null, `cooling_off_until` null, `cancelled_by` fk user null, `cancelled_at` null, `executed_at` null, `completed_at` null, `progress` jsonb not null default `{}`, `counts` jsonb null, `certificate` jsonb null, `failure` jsonb null, `created_at`, `updated_at`; **partial unique** `(org_id) WHERE state in ('pending_confirmation', 'pending_approval', 'cooling_off', 'executing')`; index `(state, cooling_off_until)` |

`insertAuditEntry` (`packages/db/src/repo/audit.ts`) refuses an org with `erased_at` set (`OrgErasedError`); the append-only triggers and the A §4.2 lock order are untouched.

### 13.2a Repo functions the streams share (F0, `packages/db/src/repo/*`)

`insertPasswordReset`, `findPasswordResetByHash`, `consumePasswordReset` (compare-and-set on `used_at is null`), `supersedePasswordResets(exec, userId)`, `countPasswordResetsSince(exec, userId, since)`, `deleteStalePasswordResets(exec, before)`; `getOpenErasure(exec, orgId)`, `getErasure(exec, id)`, `getLatestErasure(exec, orgId)`, `insertErasure`, `transitionErasure(exec, id, from, to, patch)` (compare-and-set on `state`), `listDueErasures(exec, now)`, `markErasureStep(exec, id, step)`; `listChainDigest(exec, orgId, afterSeq, limit)`. The owning stream may add more.

### 13.3 Audit actions (`actions-f.ts`, strict chain schemas)

| Action | Actor | Written on | Chain `data` |
|---|---|---|---|
| `user.invite_mailed` | user | an invite mail attempt (§4.2) | `{ userId, delivered: boolean, cause: 'no_mailer' \| 'send_failed' \| null }` |
| `user.invite_resent` | user | `POST /users/:id/invite/resend` | `{ userId }` |
| `auth.password_reset_requested` | system | 4.3g | `{ userId, outcome: RESET_OUTCOMES }` |
| `auth.password_reset` | user | 4.3e | `{ userId, revokedSessions: int }` |
| `org.erasure_requested` | user | §5.6 | `{ erasureId, solo: boolean }` |
| `org.erasure_confirmed` | user | §5.2f, solo path | `{ erasureId, coolingOffUntil: ISO }` |
| `org.erasure_approved` | user | §5.6 | `{ erasureId, coolingOffUntil: ISO }` |
| `org.erasure_cancelled` | user | §5.6 | `{ erasureId, fromState: 'pending_confirmation' \| 'pending_approval' \| 'cooling_off' }` (`pending_confirmation` added by F0: §5.1 cancels a solo erasure there, §16.3 F0-6) |
| `org.erasure_expired` | system | §5.1 | `{ erasureId }` |
| `org.erasure_started` | system | step 3 | `{ erasureId }` |
| `org.erased` | system | step 6, the last entry | `{ erasureId, entriesBefore: int, counts: Record<string, int> (<= 40 keys) }` |
| `camera.link_created` | user | §6.7 | `{ cameraId, expiresAt: ISO }` (`session_id` set) |
| `camera.link_revoked` | user | §6.7 | `{ cameraId }` |
| `camera.started` | desk (`deskActor(session.desk_ref)`: the phone is reached only through the Desk person) | `camera.ready` | `{ cameraId, width, height, facing: CAMERA_FACINGS }` |
| `camera.ended` | system | any end | `{ cameraId, by: CAMERA_STOP_REASONS, durationMs: int \| null }` |
| `camera.snapshot` | user | §6.7 | `{ cameraId, sha256, width, height }` |

`session_id` is set on every `camera.*` entry and null on the others. No new action for fixes (Keep is local, C D5) or linux-p4 (the D actions apply with `platform: 'linux'`).

### 13.4 Console (`apps/web`)

| Page / component | Behaviour | Stream |
|---|---|---|
| `/reset` (`PasswordResetPage`), the login page link, the users page resend | §4.4 | mail |
| `/app/settings/erasure` (`ErasurePage`), `<ErasureBannerSlot>` (`ErasureBanner`), `<ResidencyErasureSlot>` (`ResidencyErasure`) | §5.6, §5.7 | erasure |
| `/c`, `/c/:code` (`CameraJoinPage`), `<CameraSlot>` (`CameraPanel`), `CameraLinkAccessory` | §6 | camera |
| Touch layer, keys bar, layouts, manifest, service worker | §7 | mobile |
| `<DeskKeepSlot>` (`KeepState`), integrations unverified note, residency print | §3 | fixes |
| `EnrollDeployDialog` Linux tab, device page display type | §8.11 | linux-p4 |
| `JoinP3.tsx` Wayland download | §9.5 | wayland |

---

## 14. Security

| Asset / surface | Threat | Mitigation |
|---|---|---|
| Password reset | account enumeration; token theft from logs or `Referer`; brute force; takeover of SSO users; a stolen link reused | identical `202` and post-reply work (4.3a); token in the fragment, stored as sha256, single use, 30 min, superseded on reissue; 43-character tokens with per-IP limits; no reset for SSO-required non-break-glass users or password-less accounts; all sessions revoked on reset, no session minted; break-glass resets mailed to other admins |
| Invite mail | an intercepted invite activates an account | 7-day single-use secret (unchanged), resend rotates it; SSO-required orgs get the SSO link instead |
| SMTP | credentials leak, cleartext transport, header injection | `SMTP_URL` redacted (§14 paths); TLS required in production; plain-text bodies with sanitised names, no user-controlled header |
| Erasure | a single rogue or compromised admin destroys an org (alone, by inviting or promoting an accomplice account, or by removing the admins who would cancel); a CSRF or replay triggers it; an erasure is silently half-done | two distinct org_admins, the approver an admin for at least 7 days and not invited or promoted by the requester (5.2b), the admin set frozen while open (5.2e), both freshly authenticated and typing the slug, mail to every admin and auditor at request and approval, a 7-day cooling-off with a banner for everyone, cancel by any admin with no rate limit; CSRF header (A §6.1) on every write; resumable idempotent steps; a signed certificate stating what was done and that the chain verified |
| Erasure certificate and digest | leaking who the org was or what happened | no names, slug, email, reason or entry material; ids are unguessable uuids; rate limited |
| Phone camera | a guessed or leaked code; a camera started without consent; the server swapping the phone; tracking the phone | 60-bit single-use codes with a 10-minute TTL and per-IP limits; the code never logged (nginx `access_log off` for `/c/`); capture only after a tap, a persistent sharing bar, auto-stop when hidden; DTLS-SRTP end to end with a commit-before-reveal 6-digit camera code to compare (§6.5); `camera_busy` and revoke enforced cluster-wide by `ia:camsess:`; no user agent, cookie or storage kept |
| Mobile console | the service worker serving stale or cached data; an installed app keeping a session | shell-only cache, never `/api`, `/signal` or downloads (§7.6); the session stays the httpOnly cookie, unchanged |
| Linux service | a root process driven by a technician; X11 access as root; squatting the worker channel; reading users' secrets | the service never connects to X; the worker runs as the session user with an emptied environment; an inherited socketpair, no path; the service reads no user files or other uids' environments; key files root 0600, refused if wider |
| Linux packages and role | tampered package; the enroll config leaking in Ansible logs | sha256 published and enforced by the role (`checksum:`); `no_log` on the config; the config shredded after enrollment |
| Portal build | screen captured without the user knowing | the agent's consent plus the compositor's own per-session dialog, never persisted; the compositor's screencast indicator |

The pino `REDACT_PATHS` (`apps/api/src/lib/logger.ts`, F0) gains `'body.token'`, `'body.newPassword'`, `'*.inviteUrl'`, `'*.resumeKey'`, `'*.enrollConfig'`, `'*.smtpUrl'`; `SMTP_URL` is never logged. A bare `'*.code'` stays out (E §14), so the camera module must not pass the camera code to the logger at all (§6.2b, tested by a log-capture assertion).

---

## 15. Tests and gates

### 15.1 F0 (vitest and existing gates)

| Gate | File |
|---|---|
| every new schema: valid and invalid examples, strictness, the `companion` field (Linux only), `deviceMachineSchema` accepting `linux`, the camera messages, the certificate schema | `packages/shared/test/phase-f-schemas.test.ts` |
| every §13.3 action in `AUDIT_ACTIONS` with exactly one actor and a strict schema; no chain schema accepts a key named like a token, code or reason | same file |
| migration `0009_phase_f` applies on PGlite; `org_pepper_erased` check; the open-erasure partial unique index; `password_reset.token_hash` unique; `insertAuditEntry` refusing an erased org | `packages/db/test/phase-f.test.ts` |
| config: `FLEET_DATA_KEYS_PREVIOUS` parsing and the explicit key-id rule; `SMTP_REQUIRE_TLS` boot problem; `ERASURE_DEV_COOLING_OFF_SEC` refused in production | `apps/api/test/phase-f-config.test.ts` |
| `pnpm validate:infra` with the parity rule, the camera Permissions-Policy, the new nginx locations; `node scripts/license-check.mjs`; the existing `smoke` 26/26, `smoke:p2`, `smoke:p3`, `smoke:p4`, `smoke:recorder`, `smoke:e` green; web typecheck, test, build with every slot rendering today's output | — |

### 15.2 fixes

| Gate | File |
|---|---|
| `decryptMac` under a previous key re-seals with compare-and-set; `pnpm secrets:reseal` covers MACs | `apps/api/test/fleet-key-rotation.test.ts`, `scripts/test/reseal.test.mjs` |
| vendor shapes per §3.3 against the (corrected) fakes; `ZOHO_DATA_CENTERS` rows match their recorded sources; the unverified note | `apps/api/test/ticketing-adapters.test.ts`, `apps/web/test/integrations.test.tsx` |
| the residency print rule 3.2a | `apps/web/e2e/enterprise-residency.spec.ts` |
| Keep: the UI guard refuses non-physical toggles; the Windows applier and the Linux plan against a temp root, including a kept copy running again and "remove after this session"; `--no-self-delete` changes nothing; `ctl.event keep` sent on change and shown read-only | `ia-ui` unit tests, `ia-agent/src/serve/selfdel.rs` tests, `ia-platform/src/linux/selfdel.rs` tests, `apps/web/test/keepState.test.tsx` |
| Windows: `cargo fmt --all --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test --workspace --all-features`; WSL: the E §15.6 commands | — |
| smoke: compose-free checks (the api boots with a previous fleet key; a device MAC re-sealed on read) | `scripts/smoke/flow-f-fixes.mjs` |

### 15.3 mail

| Gate | File |
|---|---|
| the `smtp` driver against an **in-process fake SMTP server** (`apps/api/test/fake-smtp.ts`, `node:net`, 127.0.0.1, records envelopes and bodies, scripts 250 / 451 / 550 and a hang): invite mail, resend rotating the secret, SSO-required invite text, `requireTLS` refusing a server without STARTTLS | `apps/api/test/mail-invite.test.ts` |
| reset: SSO notices and reset links share one 3-per-hour cap per user (`ia:resetmail:`), so repeated requests cannot mail-bomb an SSO user; identical replies and comparable timing for known and unknown emails; eligibility table (active, invited, disabled, no password, SSO-required, break-glass); token single use, expiry, supersede, the hourly cap; confirm revokes sessions and closes sockets; no session minted; break-glass notice; every chain entry; no token in any log line or response but the mail (log capture grep) | `apps/api/test/mail-reset.test.ts` |
| web: the reset page (fragment read and removed), the login link driven by `/auth/options`, the users page resend | `apps/web/test/passwordReset.test.tsx`, `apps/web/test/usersInvite.test.tsx` |
| smoke and keyboard-only Playwright: the api started with `MAIL_DRIVER=smtp SMTP_URL=smtp://127.0.0.1:<E2E_SMTP_PORT> SMTP_REQUIRE_TLS=0`, the fake SMTP in the runner, invite → mail → accept; reset → mail → confirm → login with the new password | `scripts/smoke/flow-f-mail.mjs`, `apps/web/e2e/f-mail.spec.ts` |

### 15.4 erasure

| Gate | File |
|---|---|
| the state machine: second-admin rule, reauth, slug, expiry, cancel from both states, `erasure_exists` | `apps/api/test/erasure-flow.test.ts` |
| execution on a seeded org (users, SSO, sessions with files and hosts, recordings in the fs storage, tokens, devices with MACs, playbooks, integrations with pushes, summaries, presence keys): **every row of §5.4** checked in every table afterwards (a test reads each table and greps for every seeded email, name, label, host and file name); objects gone; `audit_entry` byte-identical before and after (hash list compared); `org.erased` is the last entry; a later `writeAudit` and a later `piiHash` both refused; `verifyChain` ok; restart-in-the-middle resumes each step, **including a crash after step 5** (the `login_attempt` rows and the step-9 mail still come from `progress.carry`); queued pushes and summaries cancelled and not picked up again; logins, REST reads and hellos during `executing` answer `org_erasing`; another org untouched | `apps/api/test/erasure-execute.test.ts` |
| the one-person paths refused: an approver invited or promoted by the requester, an approver of fewer than 7 days, a demotion, disabling or new org_admin while open (`erasure_exists`); Cancel succeeds after the request and approve buckets are exhausted; non-admin roles read only the notice | `apps/api/test/erasure-flow.test.ts` |
| the certificate vector, `verifyErasureCertificate` over raw JSON (an added field fails), `scripts/verify-erasure.mjs` with `--export --digest` on a good and a tampered set | `packages/shared/test/erasure-certificate.test.ts`, `scripts/test/verify-erasure.test.mjs` |
| the residency `erasure` block and `piiInChain` text | `apps/api/test/residency.test.ts` |
| smoke: a throwaway org, two admins, request, approve, `ERASURE_DEV_COOLING_OFF_SEC=5`, export taken during cooling-off, execution, certificate and chain digest fetched, `verify-erasure` OK; keyboard-only Playwright of the erasure page | `scripts/smoke/flow-f-erasure.mjs`, `apps/web/e2e/f-erasure.spec.ts` |

### 15.5 camera

| Gate | File |
|---|---|
| links: RBAC (session Assist only), tier and state refusals, one per session, single-use code across two nodes sharing presence, TTL, revoke; `camera.hello` with a bad code closing `4403`; resume within 60 s and not after; webrtc routing allowed only camera ↔ the session's Assist; session end closes the camera; the code never in a captured log line; every chain entry; `camera_busy` and `DELETE` issued on a node other than the session owner (two nodes, shared presence, `ia:camsess:`); TURN usernames carry `camera:<cameraId>` | `apps/api/test/camera.test.ts` (signal-kit) |
| the `ia.cam` commit-before-reveal: a wrong reveal ends the camera; a nonce sent before the commit is refused; the code vector (`mod 10^6`) matches on both sides for one set of fingerprints and nonces | `packages/shared/test/camera.test.ts` |
| shared: code normalisation, the security code vector | `packages/shared/test/camera.test.ts` |
| web: the phone page consent (nothing before the tap), stop, hidden-page stop; the console panel states, freeze, snapshot hash and download; the P1 chat QR accessory only for an exact link | `apps/web/test/cameraJoin.test.tsx`, `apps/web/test/cameraPanel.test.tsx` |
| Playwright: a P1 session (desktop Chromium Assist and Desk) and a phone context (`devices['Pixel 7']`, the fake camera device) joining by link; video arrives, freeze, snapshot chained; keyboard-only on the console panel | `apps/web/e2e/f-camera.spec.ts` |
| P3: the same with the dev agent from wave 0b (`--synthetic-capture --no-self-delete`), link sent to chat | `apps/web/e2e/camera-p3.spec.ts` (`E2E_P3=1`) |
| Android emulator: Chrome on `Pixel7_API35` opens the link through `adb reverse` (secure `localhost`), grants the camera, streams the emulated back camera to a desktop Assist | `apps/web/e2e/camera-emulator.spec.ts` (`IA_EMULATOR=1`, emulator lock) |
| recording: the recorder records a second (camera) peer of a session into its own WebM and uploads it with `source: 'camera'` (Go tests with a synthetic sender, `pnpm recorder:test`); the api routes camera ↔ recorder only, refuses `camera_unrecordable` for a recorder without the feature, stores and chains the camera recording; the console records the camera track while its session recording runs; the phone's consent text follows `recording` | `services/recorder/internal/**` tests, `apps/api/test/camera-recording.test.ts`, `apps/web/test/cameraPanel.test.tsx` |
| smoke: link, hello, ready, snapshot, end over signaling only | `scripts/smoke/flow-f-camera.mjs` |

### 15.6 mobile

| Gate | File |
|---|---|
| the manifest: `start_url` inside `scope`; the manifest link present on `/app/*` and absent on `/c`, `/join`, `/room`, `/login` | `apps/web/test/manifest.test.ts` |
| the gesture recognizer against `fixtures/touch/gestures.json` (every row of §7.2 for each Desk kind and zoom state, Trackpad mode, no kind change mid-gesture) | `packages/shared/test/touch-gestures.test.ts` |
| the overlay with synthetic touch pointer events: ops emitted with coordinates through a zoomed view; mouse and pen unchanged; the keys bar (sticky modifiers, `beforeinput` mapping, Ctrl+Alt+Del only with `sas`, nav keys only for Android) | `apps/web/test/touchOverlay.test.tsx`, `apps/web/test/keysBar.test.tsx` |
| the service worker in isolation (a fake `caches` and `fetch`): passes through every §7.6c path and non-GET; never caches no-store or non-200; old caches removed | `apps/web/test/serviceWorker.test.ts` |
| Playwright mobile projects (`apps/web/e2e/mobile.config.ts`: `pixel-7`, `iphone-15` and `ipad-pro-11` device descriptors, **all on Chromium**, the only browser installed; the app built and served with `vite preview`): layouts at each width, target sizes ≥ 44 px, P1 annotation by touch, pinch zoom sends nothing, the manifest fetched and valid, the worker registered on `/app` and **not** on `/join`, an `/api` call never answered from the worker (offline: API calls fail, the shell loads), installability criteria met; a P3 case with the wave-0b dev agent: tap, long press, two-finger scroll and keys arrive as the expected `os.*` ops | `apps/web/e2e/mobile.spec.ts` (`pnpm e2e:mobile`) |
| Android emulator Chrome: sign in, open a live P1 console, tap and pinch | `apps/web/e2e/mobile-emulator.spec.ts` (`IA_EMULATOR=1`) |

Real iPhone and iPad Safari are a manual check (no Apple host; W120).

### 15.7 linux-p4 and wayland

The §8.12 and §9.6 tables are the gate lists. Exact Linux commands extend E §15.6: `ia-service` and `ia-desktop` are no longer excluded; their Linux features are named with `package/feature` syntax (`ia-service/linux-service`). Windows gates stay green (the Linux modules are `cfg(target_os = "linux")`). Measured results (unit-security score, package sizes, ELF floors, the portal artefact's floor) are recorded here by each stream when it finishes.

### 15.8 Gates and definition of done

| Stream | Must pass |
|---|---|
| F0 | §15.1 |
| fixes | F0 gates, §15.2, `pnpm smoke:f` fixes flow, `pnpm e2e:e` |
| mail | F0 gates, §15.3, `smoke:f` mail flow, `f-mail.spec.ts` |
| erasure | F0 gates, §15.4, `smoke:f` erasure flow, `f-erasure.spec.ts` |
| camera | F0 gates, §15.5, `smoke:f` camera flow |
| mobile | F0 gates, §15.6, `pnpm e2e:mobile` |
| linux-p4 | §8.12 (T1 included; T2 only when the user runs it), the WSL and Windows Rust gates, `pnpm e2e:p4:linux`, `pnpm e2e:p3:linux` still 3/3 |
| wayland | §9.6, `pnpm e2e:p3:linux` 5/5, the Windows Rust gates |
| apple (on the Mac) | §17.6; after integration, the Windows and WSL gates of every other stream still green |

**Definition of done for Phase F.** Compose boots a production api with every key it needs, and a rotated fleet key re-seals every MAC; the residency print keeps 15 mm free with ten flows; every ticketing cell is verified or flagged with sources, and Zoho ships only verified data centres; a Desk user keeps the agent from its own UI and the console shows it; an org_admin invites by email and a user resets a forgotten password, with SSO-required orgs refusing resets except for break-glass; two org_admins erase a throwaway org, the certificate verifies offline and the remaining chain verifies; a technician sees a Desk person's phone camera in P1 and P3 sessions, freezes it and records a snapshot; a technician runs a P3 session from a phone-sized and a tablet-sized touch browser and installs the console; a Linux machine enrolls through the deb (sandbox and, when the user runs it, the throwaway distro), takes an unattended X11 session with input, and refuses pre-login honestly; a Wayland Desk shares its screen view-only through the portal build under the headless compositor; every gate above is green and the §16 table is applied to `PRD.md`.

### 15.9 Playwright facts (F0)

`apps/web/playwright.config.ts`'s default `testMatch` becomes `/(package[12]|enterprise-[a-z]+|f-[a-z]+)\.spec\.ts$/` and the P3 branch `/(package3|[a-z]+-p3)\.spec\.ts$/` with `E2E_DATA_DIR` honoured; `pnpm e2e:f` runs the `f-*` specs. The mobile and Linux suites have their own configs, and so do the emulator specs: `apps/web/e2e/emulator.config.ts` matches `/-emulator\.spec\.ts$/` (`camera-emulator.spec.ts`, `mobile-emulator.spec.ts`), starts its api and web on the stream's emulator ports (§1.5), and is run by `IA_EMULATOR=1 pnpm e2e:emulator -- <spec>`; no other config matches those files. The P3 branch honours `E2E_DATA_DIR` (closing the E §15.8 row), and the camera and mobile P3 cases run Playwright with `E2E_P3=1` and `AGENT_BIN` / `AGENT_DEV_STUB` set to the wave-0b copy, never through `pnpm e2e:p3`, which rebuilds the agent (§1.5). `apps/web/e2e/emulator-chrome.ts` boots or reuses `Pixel7_API35` headless (as `apps/android/tools/android-e2e.mjs` does), checks `pm path com.android.chrome` (absent → "not met"), maps the suite's api and web ports with `adb reverse` (so the phone origin is a secure `localhost`), connects Playwright's `_android` to Chrome, grants the camera permission through `adb shell pm grant` only for Chrome, and removes the reverse mappings and the lock in `finally`.

---

## 16. PRD deviations and open questions resolved

Earlier contracts use W1 to W91; Phase F starts at W100.

| # | PRD / task text | Phase F position | Why |
|---|---|---|---|
| W100 | PLAN §8 fixes: "the Keep (C D5) control in the console and Desk UI" | Keep is set **only** in the Desk UI (pill menu, ended view, physical input); the console shows the choice read-only through `ctl.event keep` | C §3.5 names "tick Keep" as a self-approval the technician must never be able to perform; a console control would be that by another route |
| W101 | B §14.1, E W76: email invites and password reset deferred | built; available only with `MAIL_DRIVER=smtp`; no reset for SSO-required non-break-glass users or password-less (SSO-only) accounts, who get an SSO notice instead | a reset path for an SSO user would bypass the IdP's deprovisioning |
| W102 | A §4.2, §5.3: pepper destruction "is the erasure mechanism"; DPDP erasure workflow | **org-level** erasure only; the chain keeps technicians' display names (`actor.label`) and typed `reason` text in clear; no per-data-subject erasure | the chain is append-only and its hash covers those fields; A §5.3 already keeps technician names by design (user decision 1) |
| W103 | "PII rows deleted" | rows referenced by the chain or by NOT NULL foreign keys from kept rows (`org`, `user`, `session`, `device`, `recording`) are **scrubbed**, not deleted; the rest are deleted (§5.4) | `audit_entry` references `org` and `session`, and `session` references `user`, `token` and `device` |
| W104 | PRD 12.8, PRD 4 "Phone camera via web" (P1), "Phone camera stream" (P3/P4) | one camera per session; the QR is drawn on the Desk's screen in the P1 room and in the chat of the Windows, Linux and macOS agents; the Android host makes the link tappable; anyone can type the short code; the camera **is recorded** whenever the session is (W125); snapshots are saved in the technician's browser and chained by hash, never uploaded | revision 1 sent native Desks text only and recorded nothing; the user's rule "easy to use, maximum functionalities" reversed both. Storing snapshots on the server would be a new data category with its own retention, and the browser download already gives the technician the image |
| W105 | PRD 4 "Camera sharing: P2 No" | kept: `camera_unsupported` for P2 | as the PRD says |
| W106 | PRD 5 "Controller: full native or web console" (Android), "an iPhone can be the Assist"; decision 15.6 "Android and iOS controller apps"; C W20, E W84 | the **mobile web console** is the controller on both; no native controller app | the user's decision of 2 Nov 2026 |
| W107 | full touch control | P2 sessions get touch control too, through the replayer's existing pointer, wheel and key capture in the `in_page` and `deep` modes (§7.2); tab actions stay buttons | revision 1 left P2 at layout only; the user's rule asks for maximum functionality, and the replayer capture already speaks the P2 control ops |
| W108 | PRD 5 Linux "Unattended: systemd service" | X11 user sessions only; no greeter or pre-login access (`409 prelogin_unsupported`); a locked session can be controlled under the D policy (W126) | display managers differ (GDM on Wayland, LightDM, SDDM) and attaching to a greeter as root is the riskiest part |
| W109 | D §3.3 DPAPI machine-scope sealing | Linux key files are root 0600 without OS sealing, refused if wider | no portable equivalent; root can read them, as LocalSystem can unseal DPAPI machine scope |
| W110 | D §10.1 watchdog service | systemd `Restart=on-failure` and `WatchdogSec=60` replace the second service | systemd already supervises; a second unit would add nothing |
| W111 | PRD 3/4 "deb and rpm, Ansible / config management" | unsigned packages with published sha256; no apt or dnf repository; the Ansible role lives in the repository | signing keys and repository hosting are deployment decisions outside this build |
| W112 | D hardening expectations | the unit is lightly hardened (§8.8) | device-action playbooks run as root by design and the worker must reach the X socket and the user's home |
| W113 | E §7.4, W77: portal capture unshipped behind an off-by-default feature | shipped as the **companion binary inside the single Linux download** (W127), view only; it links libpipewire, so it is not the single static-ish binary of E §7.9; its glibc floor is measured, and if it cannot meet 2.35 the measured floor is published | the user's decisions; honesty about the floor |
| W114 | PRD 5 Linux "uinput (works under Wayland)" | still no uinput in either build (E W78) | a portable user agent has no `/dev/uinput` access; the portal RemoteDesktop interface is not in the Phase F decisions |
| W115 | Linux unattended on Wayland | the service never uses the portal; a Wayland user session gets the no-screen worker | the portal requires a person to answer its dialog every session |
| W116 | A P3 response headers `Permissions-Policy: camera=()` | unchanged everywhere except `/c` and `/c/*`, which send `camera=(self)` (and deny the other powerful features) | the phone page calls `getUserMedia`; no other page needs the camera, and the replayer frame must not gain it |
| W117 | E W82 "Linux unattended deferred again" | built (§8) | the user's decision of 2 Nov 2026 |
| W118 | E §15.8 "about 7 px of headroom" | 15 mm measured with ten flows (§3.2) | a margin that survives real orgs |
| W119 | E §4.6 shapes "not verified"; E §4.2 Zoho candidate rows | verified per cell with recorded sources; an unconfirmed cell is flagged, not guessed; unverified types stay usable with a note; Zoho rows only when both hosts are documented | the release-verification item E left open |
| W120 | PRD 5 "P1 works on ... Safari and their mobile versions"; iOS controller | the iPhone and iPad layouts are tested by device emulation in Chromium; real Safari is a manual check | no Apple host and only Chromium installed for Playwright |
| W121 | — | the service worker is hand-written (no Workbox) | the shell-only rule is easier to prove in 150 lines than in a framework's configuration |
| W122 | E §1.6-style isolation "no session bus" | the logind fake and the portal stack each use a **private bus the harness starts**; never the user's | logind and the portal are D-Bus services; a private bus keeps the isolation |
| W123 | A §4.2 DPDP erasure workflow | **no legal-hold mechanism**: an erasure that two admins (or a confirmed single admin) scheduled runs when its cooling-off ends; an operator who must hold data refuses at the infrastructure level | the user's decision of 2 Nov 2026 |
| W124 | F2 "two people" | an org with exactly one eligible org_admin may erase alone: a mailed (or, with the `log` driver, once-shown) confirmation link opened within 24 h, re-authentication within 15 minutes, a 14-day cooling-off, and every other safeguard (5.2f) | the user's decision: a one-person organisation must be able to leave |
| W125 | revision 1 §6.5 "the camera is recorded by neither recorder" | the camera is recorded whenever the session is, as separate `source: 'camera'` recordings through the A.2 recorder (a second sendonly peer from the phone, as the P1 Desk does) and the console recorder; the phone says so before it starts; a session that must be server-recorded refuses a camera its recorder cannot record (`camera_unrecordable`) | the user's decision: an org that records sessions expects the camera in the record |
| W126 | revision 1 8.4e "a locked session is view-only" | controllable under the D policy; the technician may type the password into the locker | the user's decision; the D presence table is unchanged, so consent rules do not loosen |
| W127 | revision 1 §9.5 "two Linux downloads" | one download holding both binaries; the X11 binary hands over to the portal binary on Wayland when libpipewire loads | the user's decision: no choice the user cannot make from a browser |
| W128 | PRD 5 "Controller: full native or web console" (Android) | the Android host app opens the mobile console in a Custom Tab (**Give help**); no native controller UI | one app per platform both gets and gives help, without a second controller code base |
| W129 | E §8, W83, W84: macOS and iOS specified, not built | built in Phase F by the apple stream on the user's Mac (§17); ad-hoc or development signing for tests, Developer ID and notarization a release prerequisite | the user has a Mac with Xcode; a paid signing identity is not assumed |

**Earlier-contract items that stay deferred.** The macOS login window (§17.3), a native controller UI on any platform (superseded by W106 and W128), AMT serial-over-LAN byte forwarding and the D §16.3 not-built items, the 2,000-device load run.

### 16.1 PRD and spec amendments to apply

- PRD 4 "Camera sharing": the W104 shape; PRD 12.8 likewise. PRD 5 Android and iOS "Controller": the mobile web console (W106). PRD 5 Linux: unattended X11 (W108), Wayland portal build view-only (W113, W114). PRD 14: Phase F line. Decision 15.6: controller apps replaced by the mobile web console.
- PRD 12.2, 15.4 and A §4.2, §5.3: erasure as built, the kept chain fields (W102, W103).
- A §2.3 matrix: §2.1 rows. A §4.2: `org`, `user` columns and the new tables of §13.2. A §6.1: the reset and invite routes. A §6.12: §2.3. A P3 headers: W116. A §11.1: §11.
- B §14.1: built (W101). C §1.4: phone camera built (W104). C §10 D5: Keep as built (W100). C §3.5: the `keep` event.
- D §3.3 (W109), §10.1 (W110), §12 (deb, rpm, Ansible), §3.2 `platform`, §3.4 `os` and `display`, §6.2 the Linux pre-login refusal.
- E §4.2, §4.6: the verification record (W119); E §6.2e and W75: erasure available; E §7.4, W77: the portal build (W113); E §15.8: the closed rows; E W82: superseded (W117); E W89: closed (§3.1).
- PRD 5 macOS and iOS, PRD 14, decision 15.6: built as §17 (W129); the controller apps are the mobile console opened from the Android and iOS apps (W106, W128). E §8: superseded by §17 where they differ.
- `docs/LICENSE-REGISTER.md`: §10. `docs/release.md`: fleet-key rotation, `SMTP_*`, `BACKUP_RETENTION_DAYS`, the Linux package build and its prerequisites, the T2 throwaway run, the Linux manual checks, the real-Safari check, the erasure operator notes. `docs/PLAN.md`: the Phase F line.

### 16.2 Index of changes to existing code and contracts (file, symbol, old, new)

Every change is **additive** for existing callers unless the "new" column says otherwise.

**`packages/shared`**

| File | Symbol | Old | New |
|---|---|---|---|
| `src/enums.ts` | `DESK_OSES` | `['windows', 'mac', 'linux', 'cros', 'other', 'android']` | plus `'ios'` (§17.8) |
| `src/enums-p3.ts` | `AGENT_PLATFORMS`, `PLAYBOOK_INTERPRETERS` | `['windows', 'android', 'linux']`; `['powershell', 'cmd', 'sh']` | plus `'macos'`; plus `'zsh'` (§17.8) |
| `src/schemas/signal-messages.ts` | `deskClientSchema` native refine | `os` windows, android or linux | plus `'mac'`, `'ios'` (§17.8) |
| `src/schemas/signal-recorder.ts` | recorder messages | A.2 | plus `recorder.camera`; `recorder.hello.features` optional (§6.5a) |
| `src/schemas/signal-recorder.ts`, `src/audit/actions-a2.ts` | `internalRecordingMetaSchema`, recording chain shapes | desk recordings only | `internalRecordingMetaSchema` plus optional `source: 'desk' \| 'camera'` and `cameraId` (together); the chain shapes (`recording.started`, `.stored`, `.failed`, `.server_started`, `.server_stopped`) plus optional `cameraId` only, because their `source` already means "who recorded" (`'server'`) (§6.5a; corrected by F0, §16.3 F0-1) |
| `src/enums.ts` | `PARTICIPANT_ROLES` | `['assist', 'desk', 'supervisor', 'recorder']` | plus `'camera'` |
| `src/enums.ts` | `SESSION_END_REASONS` | A–D reasons | plus `'org_erased'` |
| `src/enums.ts` | `WEBRTC_PEERS` | `['assist', 'recorder']` | plus `'camera'` |
| `src/enums.ts` | `LIMITS`, re-exports | A–E | plus §13.1 keys; `export * from './enums-f.js'` |
| `src/enums-p3.ts` | `CAPTURE_PATHS` | `['dda', 'gdi', 'projection', 'xshm', 'xgetimage', 'none']` | plus `'portal'` |
| `src/agent/control.ts` | `CAPTURE_CAUSES`, event kinds | E values; seven kinds | plus `'portal_denied'`, `'portal_closed'`; plus `keep` |
| `src/agent/download.ts` | `agentBuildSchema`; new `agentPortalDistFileName` | one Linux file | optional `companion: { sha256, size }` (Linux only) |
| `src/fleet/device.ts` | `deviceMachineSchema.platform`, `interactiveStateSchema` | `z.literal('windows')`; `{ state, idleSec, at }` | `z.enum(['windows', 'linux'])`; plus optional `display` |
| `src/schemas/signal-device.ts` | `deviceHelloClientSchema` | no OS field | plus optional `os` |
| `src/fleet/installer.ts` | `installerBuildSchema`, `installerFileName`, `installerDownloadQuerySchema` | Windows MSI only | optional `platform`, `format`; `installerFileName(arch, v, format = 'msi')`; optional `format` query |
| `src/errors.ts` | `API_ERROR_STATUS`, `SIGNAL_ERROR_CODES` | A–E | plus §2.4; `SIGNAL_ERROR_CODES` also gains `org_erasing` (the socket hellos answer it; §16.3 F0-5) |
| `src/turn.ts` | `TurnPrincipal` | `` `user:${string}` \| `desk:${string}` \| `recorder:${string}` `` | plus `` `camera:${string}` `` (§6.4) |
| `src/canonical.ts` | `pepperedHash` | hashes `pepperHex + ':' + value` for any input, so a null pepper yields `sha256Hex("null:" + value)` | throws when the pepper is not 64 lower-case hex (§5.3 step 6) |
| `src/fleet/device.ts` | `serviceCapabilitiesSchema.elevation` | `z.literal('admin')` | `z.enum(['admin', 'user'])` (§8.7) |
| `src/enums-e.ts` | `ORG_SECRET_PURPOSES` | four purposes | plus `'erasure-carry'` (§5.3 step 1) |
| `src/schemas/rest-core.ts` | `userSchema` | no mail field | plus optional `inviteMailedAt` |
| `src/schemas/signal.ts` | client and server unions, side type lists | A–E messages | plus the camera messages; `CAMERA_CLIENT_TYPES` exported |
| `src/schemas/rest-core.ts` | `inviteRequestSchema`, `inviteResponseSchema` | no mail fields | plus `sendEmail?`; plus `mailed` |
| `src/schemas/rest-residency.ts` | `erasure` | `{ available: z.literal(false), note }` | **non-additive**: `available: z.boolean()`, plus optional `state`, `scheduledFor` (§5.7) |
| `src/audit/actions.ts` | `AUDIT_ACTIONS`, schemas | A–E | plus `...F_AUDIT_ACTIONS`, `...F_CHAIN_SCHEMAS` |
| `src/audit/actions-p3.ts` | `download.served` | `{ tokenId, platform, arch, version, sha256 }` | plus optional `companion`, `format` |
| `src/enterprise/integrations.ts` | `ZOHO_DATA_CENTERS`; new `INTEGRATION_VERIFICATION` | empty | verified rows only (fixes); the verification record |
| `src/index.ts` | re-exports | A–E | plus the new modules |
| `test/fixtures/agent/agent-names.json` | names | E | plus `portal`, the two causes, `keep` |

**`packages/db`** (migration `0009_phase_f`, §13.2)

| File | Symbol | Old | New |
|---|---|---|---|
| `src/schema/org.ts` | `org.auditPepper` | `char(64)` NOT NULL | **non-additive**: nullable, with `erasingAt`, `erasedAt` and the check |
| `src/schema/org.ts` | `user` | no mail or role-history column | plus `inviteMailedAt`, `roleSince` (not null, backfilled to `created_at`), `roleGrantedBy` (nullable fk user) (§5.2b) |
| `src/schema/enums.ts` | `participantRoleEnum`, `sessionEndReasonEnum`; new `erasureStateEnum` | A–E values | follow §13.1 |
| new | `src/schema/{mail,erasure}.ts` | — | `password_reset`, `org_erasure` |
| `src/repo/audit.ts` | `insertAuditEntry` | any org | refuses an erased org (`OrgErasedError`) |
| `src/repo/*` | — | — | the §13.2a functions |

**`apps/api`**

| File | Symbol | Old | New |
|---|---|---|---|
| `src/config.ts` | env schema, `Config.fleet`, `Config.mail` | one fleet key; `mail { driver, smtpUrl, from }` | plus `fleet.previousKeys`, `mail.requireTls`, `erasure { devCoolingOffSec }`, `backupRetentionDays` (§11) |
| `src/app.ts` | route plugins | A–E | plus `PHASE_F_ROUTE_PLUGINS = [mailRoutes, erasureRoutes, cameraRoutes]` |
| `src/sweeper.ts` | passes | A–E | plus `sweepMailTokens`, `sweepErasures` |
| `src/signal/conn.ts` | `Conn.side`, `Live` | `'assist' \| 'desk' \| 'recorder' \| null`; no camera | plus `'camera'`; `Live.camera` |
| `src/signal/hub.ts` | hello and dispatch | three hellos | plus `camera.hello` and `CAMERA_CLIENT_TYPES` routing to `signal/camera.ts` |
| `src/signal/relay.ts` | `handleWebrtc` | recorder and Desk/Assist routing | plus the `camera` branch (`routeCameraWebrtc`) |
| `src/mail/mailer.ts` | `MailMessage.attachments`, `SmtpMailer` | required; no TLS rule | optional; honours `requireTls` |
| `src/fleet/common.ts` | `macKeys`, `decryptMac` | the current key only | current and previous keys; lazy re-seal (W89 closed) |
| `src/fleet/routes-devices.ts` | enrollment | Windows enrollment | accepts `platform: 'linux'` (the pre-login refusal lives in `device-sessions.ts`, below) |
| `src/routes/download.ts`, `src/services/installer-dist.ts` | installer routes | MSI | plus deb and rpm by `format` |
| `src/routes/download.ts`, `src/services/{agent-dist,linux-archive}.ts` | Linux grant | a one-file archive | a two-file archive with `.ia-portal` when the companion is present (§9.5) |
| `src/services/residency.ts` | `mail` flow text, `erasure`, `piiInChain` | E | §4.1d (F0), §5.7 (erasure) |
| `src/lib/logger.ts`, `src/lib/metrics.ts` | redact paths, series | A–E | plus §14, §12 |
| `src/lib/audit.ts` | `piiHash` | hashes with whatever `auditPepper` holds | throws `OrgErasedError` when it is null (F0) |
| `src/adapters/{storage,storage-fs,storage-s3}.ts` | `ObjectStorage` | `put`, `get`, `head`, `presignGet`, `delete` | plus `list(prefix): AsyncIterable<{ key, bytes }>` (F0; §5.3 step 4) |
| `src/plugins/auth.ts` | `principalFromCookieValue`, `authenticate` | region check only | plus the `org_erasing` refusal (F0; §5.3 step 1) |
| `src/fleet/device-socket.ts` | `device.hello` | D checks | plus the `org_erasing` refusal (F0) |
| `src/routes/users.ts` | invite, role, status | A–E rules | plus `assertNoOpenErasure` (F0 call, erasure body, §5.2e) and writes of `role_since` / `role_granted_by` (F0); the invite mail and resend (mail) |
| `src/fleet/device-sessions.ts` | D §6.2 verdict errors | D | plus `prelogin_unsupported` for `linux` devices (linux-p4) |
| `src/fleet/session-hooks.ts` | P4 privileged mode | every P4 worker | refused for `linux` devices (linux-p4, §8.7) |
| `src/integrations/sweep.ts`, `src/ai/worker.ts` | sweep passes | every org | skip orgs with `erasing_at` set (erasure) |
| new | `src/{mail,erasure,camera}/*`, `src/signal/camera.ts` | — | §4, §5, §6 |

**`apps/web`**

| File | Symbol | Old | New |
|---|---|---|---|
| `src/auth/permissions.ts` | capabilities | A–E | plus §2.1 names |
| `src/App.tsx`, `src/assist/AppShell.tsx` | routes, nav, layout | A–E | plus `/reset`, `/c`, `/c/:code`, `/app/settings/erasure`, the erasure banner slot; the mobile layout (mobile) |
| `src/assist/console/{LiveConsole,ConsolePage,RemoteView}.tsx`, `agent/{AgentConsole,AgentScreen,InputOverlay}.tsx` | console | mouse-first | slots (F0), then touch, zoom, keys bar and layouts (mobile) |
| `src/components/ChatPanel.tsx`, `src/desk/SharingView.tsx` | chat | text only | plus `messageAccessory` (the P1 camera QR) |
| `src/assist/ResidencyPage.tsx` | erasure lines, print | inline; ~7 px headroom | `<ResidencyErasureSlot>`; the §3.2 print |
| `src/pages/LoginPage.tsx`, `src/assist/UsersPage.tsx` | login, users | no reset, no resend | the mail additions |
| `src/assist/tokens/EnrollDeployDialog.tsx`, `src/lib/fleetApi.ts`, `src/assist/fleet/*` | deploy, device page | Windows | plus Linux |
| `src/desk/{JoinP3.tsx,agentDownload.ts}` | Linux download | one X11 button | one button for the two-binary download (§9.5) |
| `src/main.tsx`, `index.html`, `vite.config.ts`, `public/*` | shell | no manifest or worker | §7.5, §7.6 |
| `playwright.config.ts` | `testMatch`, P3 data dir | E | §15.9 |

**`agent/`**

| File | Symbol | Old | New |
|---|---|---|---|
| `Cargo.toml` | members, dependencies | E crates | plus `ia-capture-portal`; `ashpd`, `pipewire` Linux-target; `zbus` direct for `ia-service` (Linux-target) |
| `crates/ia-service` | features, modules, `main.rs` | Windows `service` only | plus `linux-service` and `src/linux/*`; `--deregister`, `--enroll` |
| `crates/ia-session0` | transport | named pipe (`winapi`) | plus `src/unix.rs` (inherited socketpair); `LaunchBlob.linux` optional |
| `crates/ia-desktop` | binary | Windows only | plus the Linux build |
| `crates/ia-platform` | service impls | Windows | plus `src/linux/service.rs` |
| `crates/ia-platform/src/linux/selfdel.rs`, `crates/ia-agent/src/serve{,/selfdel}.rs` | Keep | `plan(.., false)`; `kept = --no-self-delete` | the Keep choice from the UI; the kept-copy rule; `--no-self-delete` = no file change (§3.4) |
| `crates/ia-ui` | Keep control, Wayland backend | none | the Keep checkbox (fixes); feature `wayland` (wayland) |
| `crates/ia-agent` | features, `pump.rs`, `desk.rs` | X11 Linux | plus `portal` |
| `crates/ia-core` | `types.rs`, `capture_decision` | E | plus `LINUX_PORTAL_FEATURES`, the portal causes, the `keep` event |
| new | `crates/ia-capture-portal`, `scripts/{logind-fake.sh,service-e2e.sh,pkg-sandbox-test.sh,portal-test.sh,throwaway-wsl.ps1}` | — | §8.12, §9.6 |

**Repository**: `packaging/linux/**` (new); `scripts/smoke-f.mjs`, `scripts/smoke/flow-f-{fixes,mail,erasure,camera}.mjs`, `scripts/smoke/fake-smtp.mjs`, `scripts/verify-erasure.mjs` (new); `scripts/elf-check.mjs` (`--allow`); `scripts/reseal-org-secrets.mjs` (MACs); `scripts/infra/compose.mjs` (parity); `package.json` scripts `smoke:f`, `e2e:f`, `e2e:mobile`, `e2e:emulator`, `e2e:p4:linux`, `linux:pkg`, `linux:throwaway`; `infra/{docker-compose.yml,.env.example,nginx/security-headers.conf,nginx/web.conf}`.

**Phase A–E contract sections amended** (apply in those documents with a pointer here)

| Contract | Section | Old | New |
|---|---|---|---|
| A | P3 response headers; §4.2 `audit_pepper`; §5.3 PII rule; §2.3; §6.12; §11.1 | `camera=()` everywhere; NOT NULL, "Phase E erasure endpoint" | `camera=(self)` on `/c` and `/c/*` only; nullable after erasure; §5 as built; §2.1; §2.3; §11 |
| B | §14.1 | invites and reset deferred | built (W101) |
| C | §1.4; §10 D5; §5.1 events; §3.5 | phone camera in E; Keep in pill and ended view, never applied | built (W104); applied, Desk-only, `ctl.event keep` (W100); `portal` path and causes |
| D | §3.2, §3.3, §3.4, §6.2, §10.1, §12, W36 | Windows only | the Linux rows of §8 (W108–W112) |
| E | §4.2, §4.6, §6.2e, §7.4, §15.8, W75, W77, W82, W89 | unverified shapes; erasure not available; portal unshipped; Linux unattended deferred; fleet key without previous keys | §3.3 (W119); §5.7; §9 (W113); §3; §8 (W117); §3.1 |
| infra | `infra/.env.example` | missing D keys | §3.1a, §11 |

### 16.3 Foundation notes (F0, 2 Nov 2026)

Corrections made against the code (each also applied where the section is cited):

| # | Section | Old | New | Why (verified in the code) |
|---|---|---|---|---|
| F0-1 | §6.5a, §16.2 | the recording chain shapes gain `source: 'desk' \| 'camera'` | the chain shapes gain optional `cameraId` only; `internalRecordingMetaSchema` gains `source` and `cameraId`, present together | `recording.stored` / `.failed` already carry `source: 'server'` (who recorded, `actions-a2.ts`); one key cannot mean both |
| F0-2 | §13.2 | `recording` gains `source`, `camera_id` | plus `recording_camera_id_present`; `recording_session_source_unique` widened to `(session_id, recorded_by, camera_id) NULLS NOT DISTINCT` | the A.2 unique `(session_id, recorded_by)` would refuse the camera recording beside the Desk's. Postgres 16 (compose) and PGlite support `NULLS NOT DISTINCT`. `getRecordingBySession` now reads Desk rows only; `insertRecording` takes an optional `cameraId` |
| F0-3 | §13.2 | two `ADD VALUE` statements | also `playbook_interpreter` add `zsh` | the pgEnum is built from `PLAYBOOK_INTERPRETERS`, which §17.8 extends |
| F0-4 | §5.7 | `erasure.note` keeps `max(300)` | `max(400)` | the binding §5.7 note is 308 characters |
| F0-5 | §2.4 | `SIGNAL_ERROR_CODES` += `camera_link_invalid`, `camera_busy` | plus `org_erasing` | the `/signal` and `/signal/device` hellos answer `org_erasing`, and a socket `error` carries a `SignalErrorCode` |
| F0-6 | §13.3 | `org.erasure_cancelled.fromState` has two values | plus `pending_confirmation` | §5.1 lets a solo erasure be cancelled before confirmation |

Where the gate and the hooks sit, beyond the §1.4 wording:

- **The `org_erasing` gate (§5.3 step 1).** `authenticate` answers `409 org_erasing` to every authenticated request (reads too). The login gate is in `mintSession` (`plugins/auth.ts`), which password, invite and SSO logins all call, so `routes/auth.ts` and `sso/complete.ts` are not edited. The Assist socket is refused at the `/signal` upgrade with HTTP 409 in `signal/hub.ts`; a null principal would have answered `not_authenticated`. `principalFromAuthSessionId` (the bridge) returns null. `device.hello` answers `error org_erasing` and closes `4403`. It is not counted in `ia_device_hello_total`, which has no label for it.
- **Not gated by F0, with no owner in §1.4: the Desk's `desk.hello` and the P4 worker hello.** Step 2 revokes every token and ends every session within the same execution, so what is left open is the gap between step 1 and step 2. **Proposal:** the erasure stream adds a one-line `erasing_at` check to `signal/desk.ts` and `fleet/worker.ts`, or this file accepts step 2 as the gate.
- `assertNoOpenErasure(ctx, org, change, exec?)` (`erasure/guard.ts`) takes `AdminSetChange` (`invite { role }`, `role { userId, from, to }`, `status { userId, role, from, to }`). It is called before each of the three changes and allows everything until the erasure stream fills it. `role_since` / `role_granted_by` are written at the invite (`roleGrantedBy` = the inviter) and on a role change that changes the role.
- **The stream hooks.** The route plugins are `PHASE_F_ROUTE_PLUGINS` (app.ts) and the sweep passes `PHASE_F_SWEEP_PASSES` (sweeper.ts). On the `camera` hub side, `CAMERA_CLIENT_TYPES` dispatches to `signal/camera.ts` (`handleCameraHello` refuses and closes `4403`; the other handlers and both routers answer `error forbidden`). A `camera.hello` on a Desk-only socket is refused. In `handleWebrtc`, a Desk frame tagged `peer: 'camera'` is refused, so no Desk can speak as the camera. `Live.camera` is `LiveCamera | null`, and `ConnSide` names the four sides. `context.ts` needed no addition.
- **Pure helpers landed whole, because no stream owns these files after F0.** `rest-camera.ts`: `normaliseCameraCode` (Crockford; `U` is refused), `formatCameraCode`, `cameraCommit`, `cameraSecurityCode` and the `ia.cam` frame schema. The repo functions of §13.2a are also landed whole (plain reads and writes). `listDueErasures` returns `cooling_off` erasures past `cooling_off_until` plus `executing` ones; expiry is left to the erasure stream. `ObjectStorage.list(prefix)` requires a prefix ending in `/`.
- **Stubs that throw `NotBuiltError`, now widened to `PhaseFStream`.** In `erasure/certificate.ts`: `erasureSigningInput`, `signErasureCertificate`, `verifyErasureCertificate`. In `touch/gestures.ts`: `createGestureRecognizer`, `mapGestureToOps`. The gesture types (`TouchSample`, `GestureConfig` with `DEFAULT_GESTURE_CONFIG`, `GestureDesk`, `GestureMode`, `GestureEvent`, `GestureOutput`) are the foundation's proposal, and mobile may refine them in the same change as this file.
- **Names added beside §13.1.**
  - enums: `OPEN_ERASURE_STATES`, `CAMERA_STATES`, `INSTALLER_PLATFORMS`, `DEVICE_HELLO_OSES`, `RECORDING_TRACK_SOURCES` (`RECORDING_SOURCES` already names who recorded).
  - recorder: `RECORDER_FEATURES`, `recorderCameraSchema`.
  - camera: `cameraRecordingSchema`, `cameraResumeKeySchema`.
  - erasure: `erasureNoticeSchema`, `erasureStatusReplySchema`, `erasureConfirmSchema`, `chainDigestQuerySchema`.
  - mail: `mailTokenSchema`.
  - audit: `fActionHasSession`.
  - integrations: `INTEGRATION_VERIFICATION`, keyed by the four vendor types (`webhook` has no vendor).
  - the Linux-only `companion` is enforced by a refinement on `agentBuildSchema` and on the dist manifest row.
- **Optional on the wire until mail lands.** `inviteResponseSchema.mailed` stays optional, so the A invite reply is unchanged until mail sends it. `userSchema.inviteMailedAt` is always sent (`toUser`).
- **Config.** `fleet.previousKeys`, `mail.requireTls`, `erasure.devCoolingOffSec`, `backupRetentionDays`. An empty `MAIL_FROM` means the default. `SMTP_REQUIRE_TLS=false` is refused in production only for a non-loopback relay.
- **apple (§17.7).**
  - `native_interpreters` already existed in `ia-core/playbook.rs`, so it is split by `cfg` and the macOS definition sits in the marked block. `macos_capabilities` is new beside `linux_capabilities`.
  - The pump's `lost` arm has no block: its `_ => false` covers macOS until apple adds a variant.
  - Marked blocks also sit in `ia-platform/src/lib.rs` and `ia-service/src/lib.rs` (the module declarations).
  - `ia-ui` has a macOS `Tray` stub (`new` returns `None`) and a macOS event-loop arm. This is the apple session's first macOS build finding.
  - `ia-agent/src/pbrun.rs` imports `Command` and `Stdio` only on Windows and Linux. This is the second finding.
  - `packaging/macos/.gitkeep` was already tracked.
  - The macOS bodies have not been compiled; the build host has no macOS target.
- **The apple download branch has no owner.** `routes/download.ts` `CONTENT_TYPES` gains `macos: 'application/zip'`, because it is a record over `AGENT_PLATFORMS`. The macOS served name and archive branch of that file (§17.2) has no owner among the streams that own `routes/download.ts` (linux-p4, wayland); the apple session raises it here when it reaches it.
- **web.**
  - `KeepState` reads `kept: boolean | null`, carried by a `kept` field the foundation added to the agent console snapshot and its `keep` event handling (`agentState.ts`, `agentConsoleController.ts`; mobile owns both from now on).
  - The slot props are `CameraSlot { session: { id, live, consoleRecording }, sendChat, tier }`, `ErasureBannerSlot { role }`, `ResidencyErasureSlot { erasure }` and `CameraLinkAccessory { message }`.
  - The default Playwright config keeps its 4000 default, so only the Phase F configs refuse 4000/4100/4105.
- **Root scripts.** `linux:pkg` runs `node packaging/linux/build.mjs`, which linux-p4 creates.

---

**Coordinator decisions on the F0 notes (2 Nov 2026, binding).**
- The `org_erasing` refusal on `desk.hello` (`apps/api/src/signal/desk.ts`) and on the P4 worker hello (`apps/api/src/fleet/worker.ts`) belongs to the **erasure** stream: one guard call each, answered with the signal error `org_erasing` that F0 added. Those two lines join the erasure row of §1.4. Token revocation in §5.3 step 2 stays as a second line of defence, not the only one.
- The macOS branch of `apps/api/src/routes/download.ts` and `services/agent-dist.ts` (serving the macOS agent and the PKG) belongs to the **apple** stream. Because the apple session works on the Mac, its edits to those two files are limited to a `// apple-owned: begin` / `// apple-owned: end` block that the coordinator places on integration; until then the macOS download is reported "not served".
- The `kept` field F0 added to `apps/web/src/assist/console/agent/agentState.ts` and `agentConsoleController.ts` is accepted as an F0 shape; from now on both files are owned by **mobile**, and the fixes stream's `KeepState.tsx` reads `kept` through `<DeskKeepSlot>` only.

## 17. macOS agent, macOS unattended and the iOS app (stream apple)

Promoted from E §8 (specified there, not built) by the user's decision of 2 Nov 2026 (W129), and updated to the code as it stands: the pure frame code is `ia-frame` (`convert`, `scale`, `canvas`); the OS seams are the `ia-platform` traits (`Capturer`, `InputSink` with `refuses_pointer` / `refuses_keyboard`, `ClipboardBridge`, `Elevation`, `SelfDelete`, `ProtocolHandler`, `KnownFolders` in `src/traits.rs`; `ServiceHost`, `DesktopBridge`, `Waker`, `Amt`, `SecretInjector` in `src/service.rs`); the Linux work set the pattern for a non-Windows agent (E §7: `ia-capture-x11`, `ia-input-x11`, `ia-platform/src/linux/*`) and §8 of this contract the pattern for a non-Windows service. E §8 stays in force where this section does not replace it.

### 17.1 Build host, signing and the session that builds it (binding)

| Item | Binding |
|---|---|
| Host | the user's Mac, a **separate Claude session**, with Xcode and its command-line tools; Rust stable (`rustup`, user-level) for `aarch64-apple-darwin` (and `x86_64-apple-darwin` only if `shiguredo_libvpx` serves it: it published only `macos_arm64` when E was written, so Intel Macs are a release item, not a gate); Node 22 and pnpm for the api the end-to-end run needs (absent: that gate is reported **not met**) |
| Reaching the code | by git only: the apple session pulls after F0 is pushed and pushes a branch; the coordinator integrates it. It **never edits a file or a marked block another stream owns** (§1.4); a shared need is written into this file first and landed by F0 or by the owner |
| Signing | **no paid Apple signing identity is assumed**: tests and dev builds use ad-hoc signing (`codesign -s -`) for macOS, and the simulator or a free development team for iOS. A Developer ID Application and Installer certificate, notarization (`notarytool`) and stapling are **release prerequisites** in `docs/release.md`; until the user provides them the artefacts are reported "not signed for distribution" and never served as if they were |
| TCC | grants attach to the code-signing identity; an ad-hoc signed build has a new identity per build, so the user re-grants after rebuilding. Expected, and stated in the dev guide |

### 17.2 macOS portable agent (P3)

| Item | Binding |
|---|---|
| Crates | `ia-capture-mac` (**ScreenCaptureKit**, macOS 12.3+: `SCShareableContent`, one `SCStream` per consented display, BGRA `CVPixelBuffer` to `ia-frame` I420; `next_frame` keeps the E rule); `ia-input-mac` (**CGEvent**: mouse and keyboard events posted at `kCGHIDEventTap`, Unicode text through `CGEventKeyboardSetUnicodeString`, the W3C `code` to macOS virtual-key table with a fixture; `refuses_pointer` / `refuses_keyboard` implement the C §3.5 / E 7.3c guard over the agent's own windows); `ia-platform/src/macos/*` (`SelfDelete`: remove `~/Library/Application Support/IndiansAssist` and the bundle on quit; `ProtocolHandler`: `CFBundleURLTypes` in `Info.plist`, nothing written at run time; `KnownFolders`: `~/Downloads`, `~/Library/Application Support`; `Elevation`: `user`, no hand-over; single instance over a Unix socket in the per-user temp directory with `getpeereid` and image checks, the E §7.7 reasoning). Framework access through the `objc2` family (`objc2`, `objc2-foundation`, `objc2-app-kit`, `objc2-screen-capture-kit`, `objc2-core-graphics`, `block2`; MIT; versions pinned at install, §10), under `[target.'cfg(target_os = "macos")'.dependencies]` only |
| Wire | `desk.hello.client` `kind: 'native'`, `os: 'mac'` (`DESK_OSES` already has `mac`; the native refine in `schemas/signal-messages.ts` gains it, F0), `platform: { osVersion, arch: 'arm64' \| 'x64' }`; `AGENT_PLATFORMS` gains `macos` (F0) |
| Capabilities | what TCC has granted at `desk.hello` (E §8.1): `screen`, `multi_monitor` only with Screen Recording; `input`, `input_text` only with Accessibility; plus `clipboard` (`NSPasteboard`, text), `files`, `chat`, `playbooks`, `recorder`; `elevation: 'user'`; `interpreters: ['zsh', 'sh']` (`PLAYBOOK_INTERPRETERS` gains `zsh`, F0); VP8 and VP9 through libvpx |
| TCC flow, in plain words | the consent window shows two steps, "Allow screen recording" and "Allow control", each with one sentence of why, a button that calls the system request (`CGRequestScreenCaptureAccess`; `AXIsProcessTrustedWithOptions` with the prompt option), a button that opens the exact System Settings pane, and **Check again**; the session goes on with whatever is granted and the console greys the rest in words (the E §7.4 no-screen state reused). TCC is never bypassed (PRD 5) |
| UI | the consent window, pill and menu-bar item (the tray) through `ia-ui` on macOS (eframe with its AppKit backend, `tray-icon` on macOS); the pill is kept out of the capture by an `SCContentFilter` that excludes the agent's own windows (the macOS equivalent of `WDA_EXCLUDEFROMCAPTURE`) |
| Playbooks | `zsh` and `sh` with the E §7.8 runner rules (body on fd 3, stdin `/dev/null`, `IA_PARAM_*`, process-group kill); `requiresElevation` refused |
| Download | a per-download **`.zip`** with stored (not deflated) members, so the bytes stay a pure function of the grant and `Range` works: the cached members of the signed `IndiansAssist.app` plus a per-request signed sidecar `IndiansAssist.iaconfig` beside it (C §2.4 rules, honoured only next to a bundle named `IndiansAssist.app`). The zip is named `IndiansAssist-<region>-<dddd>-<dddd>-<dddd>.zip`, but the app cannot see that name after extraction, so the sidecar is the macOS carrier. Join page: **Download for Mac (Apple silicon)** |
| Keep, self-delete, deep link | Keep copies the app to `~/Applications/IndiansAssist.app` (§3.4 rules, Desk only); self-delete removes the bundle and the support directory; the deep link through `CFBundleURLTypes`; the camera-link QR in the agent's chat (§6.1) |

### 17.3 macOS unattended (P4)

| Item | Binding |
|---|---|
| Processes | a **LaunchDaemon** `ia-service` (root; `/Library/LaunchDaemons/com.indiansassist.agent.plist`, `KeepAlive`, `RunAtLoad`) holding the identity, the `/signal/device` socket, the policy, the queue, the waker and the tamper outbox, as on Windows and Linux; a **LaunchAgent** worker `ia-desktop` (`/Library/LaunchAgents/com.indiansassist.desktop.plist`, `LimitLoadToSessionType: Aqua`) started by launchd in every GUI login session, connecting to the daemon's socket `/var/run/indiansassist/worker.sock`. The daemon accepts a peer only when `getpeereid` gives the console user's uid and the peer process (`LOCAL_PEERPID`) satisfies the installed worker's code-signing designated requirement; the worker checks the daemon the same way. The `ia-session0` blob and frames are reused unchanged. The login window is out of scope (as the Linux greeter, W108) |
| Identity at rest | the device keys in the System keychain as generic-password items readable only by the daemon's code-signing identity (the D §3.3 DPAPI analogue), never in a plain file |
| Enrollment | the D §12.3 `enroll.iaconfig` at `/Library/Application Support/IndiansAssist/enroll.iaconfig` (root, 0600), placed by the PKG when the admin embeds it or by MDM; shredded after use |
| Consent and capabilities | the D §6.2 table, "present" = a console user logged in and unlocked; the worker's features are what its own TCC grants allow. **Screen Recording cannot be pre-granted by MDM** (Apple lets a PPPC profile pre-grant Accessibility and let a standard user approve Screen Recording), so the first session on a machine needs a person once; the console says so in words. `elevation: 'user'`; privileged mode refused as on Linux (§8.7) |
| Packaging | a **PKG** built with `pkgbuild` and `productbuild` (payload under `/Library/IndiansAssist/`, the two plists, a postinstall that loads them with `launchctl bootstrap` only on the boot volume, and an uninstall script running the bounded `--deregister` and ignoring its exit status); an **MDM PPPC profile template** `packaging/macos/IndiansAssist-PPPC.mobileconfig` (Accessibility allowed for the worker's code requirement; ScreenCapture `AllowStandardUserToSetSystemService`); installer manifest `platform: 'macos'`, `format: 'pkg'` |

### 17.4 iOS app (`apps/ios`)

| Item | Binding |
|---|---|
| Shape | one app, **IndiansAssist**, with two entries: **Get help** (share this iPhone's or iPad's screen, view only) and **Give help** (opens the mobile Assist console `<origin>/app/` in an `SFSafariViewController`, sharing Safari's cookies; no native controller UI, W106) |
| Get help | a **ReplayKit Broadcast Upload Extension** started from the system picker (`RPSystemBroadcastPickerView`) after the app's own consent screen, which says plainly, before and during: "The technician can see your screen. They cannot control your iPhone; Apple does not allow it." The extension joins as a native Desk: `kind: 'native'`, `os: 'ios'` (`DESK_OSES` gains `ios`, F0), a `p3_portable` token like the Android host, the C §1.3 `ia.sec` handshake ported to Swift and checked against the shared `sec-handshake` fixtures, capabilities `{ monitors: 1, features: ['screen', 'chat', 'files'], elevation: 'user', interpreters: [] }`. It holds the signal socket, the peer and the control channel itself (the containing app is suspended while another app is shown) and stays inside the extension memory limit by encoding at most 1280 px on the long edge at 15 fps. Chat and received files appear in the app through an App Group container. Token entry: the `indiansassist://join?t=` scheme, a QR scan, or a pasted code (no universal links: they need a file on every self-hosted origin) |
| WebRTC | a WebRTC iOS framework (Google's WebRTC, BSD-3-Clause, a pinned binary xcframework through Swift Package Manager; version and checksum recorded in §10 at install) |

### 17.5 Safety rules (binding for the apple stream's tests)

| # | Rule |
|---|---|
| A1 | Automation runs every agent with `--synthetic-capture` and `--no-self-delete`; a real ScreenCaptureKit or CGEvent run needs a TCC grant and is a manual check |
| A2 | **No TCC database edits**: no write to any `TCC.db`, no `tccutil reset` of anything, no profile installed on the Mac by a script or test |
| A3 | **No system-wide installs on the Mac**: no `sudo installer`, no `launchctl bootstrap system`, no write to `/Library`, `/usr/local` or `/Applications` by a test; the daemon and worker run in a dev mode as the current user with a temporary data directory and a socket under a temporary directory |
| A4 | PKG **content** checks are read-only (`pkgutil --payload-files`, `pkgutil --expand` into a temp directory, `plutil -lint` on every plist and the profile). A PKG **install** test runs only in a throwaway macOS virtual machine the harness clones and deletes, when the user has one (for example `tart` or UTM); otherwise it is a manual check |
| A5 | iOS tests run on the simulator; a broadcast extension cannot be driven there end to end, so its session logic is a unit-tested library target and a real broadcast is a manual check on a device |
| A6 | S1, S5 and S6 of §1.6 apply unchanged (read-only playbooks, no elevation prompt, synthetic email addresses) |

### 17.6 Gates (runnable on the Mac)

`cargo fmt --all --check`; `cargo clippy -- -D warnings` and `cargo test` for the workspace members that build on macOS with the macOS features (`ia-agent/media,ia-agent/macos,ia-agent/gui,ia-agent/dev`, `ia-service/macos-service`), including the pure tests of every new crate (the key table, TCC state to features, the single-instance decision, the self-delete plan against a temp root); the macOS dev agent with `--synthetic-capture --no-self-delete` joining a `p3_portable` session against an api on the Mac (`apps/web/e2e/package3-mac.spec.ts` under a P3-style config on ports 4170 and 5340, data `./data/e2e-mac`): knock, `desk.hello` with `os: 'mac'`, the security code, video, a click, chat, a file, a read-only `zsh` playbook, Stop, the chain; the dev daemon and worker as the current user enrolling and serving one unattended `auto_grant` session (synthetic); `xcodebuild test` for the iOS app and its library targets on a simulator; the A4 content checks. After integration the Windows and WSL gates must stay green (every macOS line is behind `cfg(target_os = "macos")`).

### 17.7 F0 hooks for apple (binding)

F0 lands, compile-checked on Windows and in WSL for their non-macOS parts: the stub crates and modules of §1.4's F0 row, and one `cfg(target_os = "macos")` block per place the apple code must plug in, marked `// apple-owned: begin` and `// apple-owned: end`: in `ia-agent` (`pump.rs` capture source, `serve.rs` sinks, `desk.rs` capabilities, `main.rs` entry, `Cargo.toml` feature `macos`), `ia-core` (`types.rs` `macos_capabilities`, `playbook.rs` `native_interpreters`), `ia-ui` (the macOS target table, the window-level and capture-exclusion hook) and `ia-desktop` (`main.rs` macOS entry). Only the apple stream edits inside those markers, and no other stream does; that makes the ownership mechanical. If a block is missing, the apple session amends this file and the coordinator lands it.

### 17.8 Shared names for apple (F0)

`AGENT_PLATFORMS` += `macos`; the native `deskClientSchema` refine accepts `os: 'mac'` and `'ios'`; `DESK_OSES` += `ios`; `PLAYBOOK_INTERPRETERS` += `zsh`; `INSTALLER_FORMATS` += `pkg`, `installerBuildSchema.platform` += `macos`; `agentDistFileName('macos', arch, v)` = `IndiansAssist-macos-<arch>-<v>.app.zip`; `deviceMachineSchema.platform` += `macos` (`DEVICE_PLATFORMS` already has it); `deviceHelloClientSchema.os` += `macos`; `CAPTURE_PATHS` += `sck`. Each is additive and indexed in §16.2.

## Decisions recorded (formerly open questions)

The user decided every revision-1 open question on 2 Nov 2026; each is bound in the section named and listed in the header.

1. **What erasure leaves in the chain:** technicians' display names and typed reasons stay (§5.4; W102).
2. **Single-admin orgs:** may erase alone with a confirmation link and a 14-day cooling-off (§5.2f; W124).
3. **Timings:** 7 days to approve, 7 days of cooling-off, re-authentication within 15 minutes (§5.2).
4. **Legal hold:** none (W123).
5. **Backups:** age out under the operator's retention, stated in the certificate (§5.4, §5.5).
6. **The phone camera:** recorded whenever the session is recorded, announced on the phone first (§6.5a; W125).
7. **A locked Linux X11 session:** controllable under the D policy; the greeter stays out (§8.4e; W126).
8. **The Linux download:** one download holding both binaries, with an automatic hand-over on Wayland (§9.5; W127).

No open question remains. A new one raised by the apple session is added here before that session builds against it.

*End of Phase F contracts. Amend this file first, then the code.*
