# Phase D technical contracts (binding): Package 4, installed agent with unattended access, wake and power-on, fleet management, mass deployment

Status: binding for Phase D. Revision 1, 1 Nov 2026. Implements PRD section 3 "Package 4", section 4 (feature matrix P4 rows), section 5 (Windows unattended; macOS/Linux unattended rows are scoped to Phase E here), section 6 (enrollment tokens that mint a long-lived device identity then are discarded), section 7 (device identity, consent and unattended policy, credential vault), section 10 (device table), section 11 (`POST /devices/:id/wake`, `POST /devices/:id/script`), section 12 items 5 (LAN waker mesh), 12 (offline action queue) and 13 (self-healing, tamper-alerting agent), section 13 (non-functional), and decision 15.3 (AMT power-on ships in v1, hardware gated). It also delivers the capabilities PRD 15.7 / decision 7(d) moved out of Phase C into "the Phase D service": secure-desktop and lock-screen capture, service-grade input that survives UAC dialogs, input lock and privacy screen.

**Phase A (`docs/specs/phase-a-contracts.md`, "A"), Phase A.2 (`docs/specs/phase-a2-recorder.md`, "A.2"), Phase B (`docs/specs/phase-b-contracts.md`, "B") and Phase C (`docs/specs/phase-c-contracts.md`, "C") stay binding**; this document only adds to them and lists every amendment in section 16. Four streams build from it in parallel without talking: **service** (`agent/`, Rust, new crates), **shared/db/api** (`packages/shared`, `packages/db`, `apps/api`), **web/fleet console** (`apps/web`), **packaging** (`packaging/`, scripts, infra, CI, licence register). If something here is wrong, amend this file first, then the code.

Vocabulary (inverted): **Desk** = the employee's computer being helped (now runs the installed service). **Assist** = the technician console (`apps/web`). "P4" = Package 4, tier `p4_installed`. "Service" = the installed Windows service. "Agent" = the Phase C portable Rust client (still the per-session worker; P4 reuses it as the desktop worker, §4). "Device" = an enrolled P4 machine with a cryptographic identity.

Conventions: everything in the A, B and C conventions tables applies (camelCase wire keys, `ts` = integer ms, ISO 8601 elsewhere, lower snake_case enums, base64url without padding, lower-case hex, `tier` never `package`, `monitorId`/normalised coordinates/`AgentConsentLevel`/encrypted-channel rules of C §1). New ones:

| Convention | Rule |
|---|---|
| `deviceId` | the `device.id` UUID; printed to the user and in audit as `device:<first 8 chars>` for a `device` actor |
| Device identity key | a per-device Ed25519 key pair generated **on the device** at enrollment; the private key never leaves the device (DPAPI-at-rest, §3.3); the public key is `device.public_key` (base64url 32 bytes), and `kid` of it (C/A `kidOf`, 16 hex) is `device.key_id` |
| Section references | "A §7.3" = Phase A; "B §5" = Phase B; "A.2 §6" = recorder; "C §7" = Phase C; "§4" = this document |
| Package and module names | `agent/` gains crates `ia-service` (the Windows service), `ia-session0` (session/desktop bridge), `ia-waker` (LAN waker + AMT), `ia-vault` (credential-injection client); `@indiansassist/shared` gains `src/fleet/*`; `apps/api` gains `src/fleet/*` and `src/signal/device.ts`; `packaging/` holds the MSI/GPO/Intune artifacts |
| Ownership of names | every wire message, enum, limit and schema is defined once in `packages/shared` and mirrored by the Rust (`serde`) types; §13.1 is the index; cross-language fixtures extend `packages/shared/test/fixtures/agent/*.json` and gain `packages/shared/test/fixtures/fleet/*.json` |
| Libraries added | Rust crates and tools are listed with licences in §11.2 and added to `docs/LICENSE-REGISTER.md` in the same change; the web adds nothing new; packaging adds **WiX Toolset** (installed as a .NET tool, §12.2) |

---

## 1. Scope, principles and architecture decisions

### 1.1 In scope (Phase D, Windows)

| # | Deliverable | PRD |
|---|---|---|
| 1 | The Windows **service** install, running as `LocalSystem`, surviving logoff and reboot, available before any user logs in | 3, 5 |
| 2 | **Enrollment**: an `enrollment` token mints a long-lived **device identity** (device key pair + `device` row) then is discarded; the device thereafter authenticates by signature, never by the token | 6, 7, 10 |
| 3 | **Unattended access**: an Assist opens a session to an enrolled device with nobody at the Desk, **policy-gated and logged**, with the visible indicator still mandatory and an optional one-time local approval captured at enrollment | 3, 7 |
| 4 | Service-grade capabilities a user/admin process could not provide (C §7.4, W9): **secure-desktop and lock-screen capture**, **service-grade input** that survives UAC dialogs and the secure desktop, **input lock**, **privacy screen** | 3, 5, 7, 12.3 |
| 5 | **Wake on LAN** (`POST /devices/:id/wake`) via a **LAN waker mesh**: any online P4 device wakes its sleeping subnet peers with a magic packet | 3, 11, 12.5 |
| 6 | **Remote power-on from off** via **Intel AMT / vPro**, self-hosted, hardware gated and surfaced in the fleet view (decision 15.3, v1) | 3, 11, 15.3 |
| 7 | **Fleet management**: devices, groups, tags, and **policy per group**; a fleet console page | 3, 10 |
| 8 | **Mass deployment**: a signed **MSI** (built with WiX), GPO and Intune guidance, branded per org | 3, 4, 5 |
| 9 | **Offline action queue**: file pushes and playbooks queued for an offline device, executed and logged at next check-in | 12.12 |
| 10 | **Self-healing, tamper-alerting agent**: the service notices if it is stopped, disabled or modified and raises an audited alert | 12.13 |
| 11 | **Remote printing** of a document to a device's default printer through a playbook-style action (PRD 4 P4 "Remote printing: Yes") | 4 |
| 12 | **Credential vault** injection (OpenBao / Vault) for privileged P4 workflows (credential injection, never exposure) | 7, 8 |

### 1.2 Out of scope (deferred)

| Item | Phase | Note |
|---|---|---|
| macOS `launchd` daemon and Linux `systemd` unit (unattended on those OSes) | E | the `ia-platform` traits (C §11.1) are extended with `ServiceHost`, `DesktopBridge`, `Waker`, `Amt`, `VaultClient` so the ports are mechanical; this document binds **Windows** |
| Android unattended / persistent host | E | the Android host stays attended (C §12); "Keep installed" (C §10 D5) is still only a user-level copy |
| iOS anything | E | unchanged |
| Pre-boot full-disk or BIOS management beyond AMT power-on (e.g. PXE re-image, BIOS settings push) | later | AMT is power-on, SOL console and boot-device redirection only (§8.3); deeper AMT/MEBx provisioning is a follow-up |
| Automatic patch management / software distribution beyond the offline action queue running playbooks | later | playbooks are the mechanism; a package manager is not built |
| Billing / seat metering for P4 devices | E | PRD decision 15.2 is per Assist seat; device count is reported in the fleet view and residency report but never metered here |

### 1.3 Principles

| # | Principle | Consequence |
|---|---|---|
| P1 | **Same session, installed Desk.** A P4 session is a C-style `p4_installed` session whose Desk is the installed service's desktop worker, a native WebRTC peer. Signaling, `ia.sec`, the recorder, chat, files, annotations, playbooks, elevation-less admin (the service is already `LocalSystem`), audit and recordings are reused unchanged unless §16 says otherwise. | The console, api hub and recorder need additions, never rewrites |
| P2 | **Identity, not a bearer.** After enrollment the device never presents the enrollment token again. It authenticates to `/signal` with a signed challenge over its device key (§3.4). A stolen enrollment token is useless after first enrollment (single-mint) and a stolen disk is useless without the DPAPI-sealed key and the machine it was sealed on (§3.3). | §3, §14 |
| P3 | **Consent is visible even when unattended.** PRD 7 forbids silent watching. An unattended P4 session shows the same always-on-top pill, tray state and recording dot as C §3.5 on whatever desktop is active (including the secure desktop and the logon screen, §5.3), plus a per-session **consent receipt** (PRD 12.14) and, when the policy requires it, a local approval the sitting user (if any) must grant. The indicator cannot be switched off and is immune to injected input (C §3.5 self-defence, re-imposed by the service). | §5, §6 |
| P4 | **Unattended is a policy, logged per use.** Whether a device may be entered with nobody present, and under what conditions (hours, approval, recording), is the device's **unattended policy**, set per group and overridable per device (§6). Every unattended entry writes `session.unattended_started` with the policy snapshot that allowed it; a device whose policy forbids it answers `consent_required` and waits for a local human. | §6, §3.8 |
| P5 | **Least privilege per action still holds.** The service runs as `LocalSystem` because capture/input across desktops and the lock screen need it, but every privileged *action* (a `requiresElevation` playbook, a secret injection, input lock, privacy screen) is still requested per action with a typed reason, logged, and gated on the session level `elevated` (§5, §8). `LocalSystem` is the floor the OS forces for the capability, not a licence to skip the audit. | §5, §7 |
| P6 | **The relay stays blind.** Media is DTLS-SRTP, every data channel but `ia.sec` is XChaCha20-Poly1305 under per-session keys (C §1). The device-auth challenge and the enrollment handshake are the only new plaintext on the wire, and both are signatures, not secrets. | §3, §14 |
| P7 | **Visible when tampered, not silent.** A service that is stopped, disabled, deleted or whose binary changed raises an audited `tamper.alert` through an independent watchdog and, on next check-in, a backfilled event; a disabled agent is a visible fleet state, never an unexplained offline. | §10 self-healing, §3.8 |
| P8 | **Honest about hardware gates.** AMT power-on works only where the hardware is present and provisioned; WoL works only with something awake on the subnet. Both report capability per device and the fleet view shows "available / not available", never a button that silently fails. | §8, §13.4 |

### 1.4 Architecture decision: service + session-0 bridge + desktop worker (binding)

A Windows service runs in session 0 and cannot draw on a user's desktop, capture it, or inject input into it directly; capture and `SendInput` must run **in the target interactive session** (the console session, or the secure/logon desktop). The binding shape (W28, rejecting "do everything in the service process"):

| Process | Runs as | Owns |
|---|---|---|
| **`ia-service`** (the service, one per machine) | `LocalSystem`, session 0, auto-start | the device identity and its DPAPI-sealed key, the persistent `/signal` WS connection and device-auth, the unattended-policy decision, the offline-action queue drain, the waker/AMT roles, the self-heal watchdog registration, the credential-vault client, and spawning/supervising the desktop worker |
| **`ia-desktop`** (the desktop worker, one per active session being shared) | the service launches it with `CreateProcessAsUser` into the target session, token from `WTSQueryUserToken` for an interactive session, or a `LocalSystem` token duplicated onto `Winsta0\Winlogon` / the secure desktop for the logon screen (§5.3) | the Phase C agent session logic (capture, encode, `ia.sec`, the seven channels, input injection, the pill/panel/tray, playbooks, voice) — it **is** the Phase C `ia-agent` serve loop reused, with the token/consent source replaced by an inherited handoff from the service (§4.2) |
| **`ia-watchdog`** (the self-heal watchdog) | a second service + a scheduled task (§10), `LocalSystem` | detect-and-restart/alert only; it holds no session state and no keys |

The service and the desktop worker talk over a named pipe (§4.2, same hardening family as C §7.2/§11.5). The desktop worker reuses C's `ia.sec`, codec, input and playbook code verbatim; what P4 adds is above it (identity, policy, desktop/secure-desktop selection, service-grade input) and beside it (waker, AMT, fleet). The rejected single-process design cannot touch the secure desktop or survive a user logoff, which is the whole point of Package 4.

---

## 2. Tiers, tokens and the fleet model

### 2.1 Tier and token types

`p4_installed` (A §2.1) becomes functional. Enrollment uses `typ = enrollment` on a `p4_installed` token (A §3.2: 7 d default, 30 d max, `p4_installed` only). The attended P4 flow (a technician opens an *attended* session to an installed device) uses the device identity, not a fresh token (§3.5); `one_time` / `timed` P4 tokens are **not** minted for attended entry (W29: the device is the credential once enrolled). `PublicToken.joinSupported` stays `false` for `p4_installed` and `enrollment` (there is no `/join` browser page for P4; enrollment happens through the installer, §12), and `desk.hello` on a `p4_installed`/`enrollment` token still answers `join_unsupported` (A §3.5) — the device uses the new `device.*` messages (§3.4), never `desk.hello`.

### 2.2 Device, group and policy (binding shape)

| Object | Binding |
|---|---|
| **Device** | one row per enrolled machine (§13.2): identity key, platform, agent/service version, capabilities (the service-grade features, waker, amt), group, tags, unattended policy override, last-seen, LAN segment, AMT inventory, tamper state |
| **Group** | an org-scoped named set of devices; carries the **default unattended policy** for its members and default tags; a device belongs to at most one group (`device.group_id`, nullable → the org's ungrouped default policy) |
| **Policy** | `UnattendedPolicy` (§6.1) lives on the group (default) and optionally on the device (override, `device.unattended_policy`); the effective policy is `device override ?? group ?? org default` resolved by shared `resolveUnattendedPolicy(device, group, orgDefault)` |

---

## 3. Enrollment and device identity (PRD 6, 7, 10)

### 3.1 Enrollment flow (binding)

1. An org_admin creates an **enrollment token** (`typ = enrollment`, tier `p4_installed`, §2.1) and, on the tokens page, either downloads a **branded MSI** carrying a signed `enroll.iaconfig` (§12.3) or copies the enrollment token to hand to a deployment tool (GPO/Intune).
2. The MSI installs the service as `LocalSystem`, auto-start, under `%ProgramFiles%\IndiansAssist\`.
3. On first start the service generates a device Ed25519 key pair (`ia-service::identity`), seals the private key with DPAPI machine scope (§3.3), and reads the enrollment token from the signed `enroll.iaconfig` placed beside the binary (filename/clipboard carriers of C §2.1 do **not** apply to the service; config comes from the sealed install config only).
4. The service calls `POST /api/v1/devices/enroll` (§3.2) with the enrollment token and the device public key and machine facts. The server verifies the token (A §3.5, `typ === 'enrollment'`, `tier === 'p4_installed'`), creates a `device` row bound to the token's org and region, binds `device.enrolled_by_token_id`, and **spends the token** (an `enrollment` token mints **one** device; `status → used`, `used_at` set, W30 — the PRD's "then discarded"). It returns the `deviceId`, a short-lived **device bootstrap credential** (a signed statement the device echoes on its first `device.hello`, §3.4), the region origin, and the effective group/policy snapshot.
5. The service **deletes the enrollment token** from `enroll.iaconfig` (overwrite-and-remove, C §2.4 shred) and from memory the moment enrollment succeeds; from then on it holds only its `deviceId` and sealed key. A re-enroll (disk restore, re-image) needs a fresh enrollment token; the old device row is marked `superseded` if the same machine fingerprint re-enrolls (§3.6).

### 3.2 Enrollment endpoint (`apps/api`)

| Method / path | Auth | Request | Response |
|---|---|---|---|
| `POST /api/v1/devices/enroll` | none (bearer = enrollment token in the JSON body, `X-Requested-With` required, no cookie, no `Origin`, A §6.1 accepts an absent `Origin`) | `{ token: string, devicePublicKey: base64url(32), deviceKeyProof: base64url(Ed25519 over utf8("ia-enroll-v1"||tokenId||devicePublicKey)), machine: { name (<=80), platform: 'windows', osVersion (<=32), arch: 'x64'\|'arm64', serviceVersion, hwFingerprint: hex64, amt: AmtInventory\|null, capabilities: ServiceCapabilities } }` | runs A §3.5 on `token`; requires `typ === 'enrollment'` and `tier === 'p4_installed'` (else `400 invalid_token_type`); verifies `deviceKeyProof` with `devicePublicKey` (proves possession of the private key, else `400 token_bad_signature`); `status === 'active'` (else `410 token_gone`); creates the `device` row (region = token region, group = the token's `device_group_id` if the token carried one else null, status `enrolled`), sets `enrolled_by_token_id`, marks the token `used` atomically (`Presence.consume`-style row lock, so two racing enrol calls on one token yield exactly one device, the second `410 token_used`); mints a **bootstrap credential** `boot` = 32 CSPRNG bytes base64url stored `ia:de:<sha256Hex(boot)>` = `{ deviceId, region }` TTL `LIMITS.deviceBootstrapTtlSec` (300); `201 { deviceId, boot, region, apiOrigin, signalUrl, keyId, group: { id, name } \| null, policy: UnattendedPolicy }`; audit `device.enrolled { deviceId, tokenId, keyId, platform, group }` (actor system, `session_id` null). 5 / minute per IP. |

### 3.3 Private key at rest (binding)

The device private key is sealed with **DPAPI machine scope** (`CryptProtectData` with `CRYPTPROTECT_LOCAL_MACHINE`, via `ia_platform::sys_lib("crypt32")`, §C 14 late-binding) plus an additional entropy blob stored under the service's `HKLM\SOFTWARE\IndiansAssist\Device` key with an ACL granting only `SYSTEM` and `Administrators`; the sealed blob lives in `%ProgramData%\IndiansAssist\device.key` (ACL `SYSTEM`+`Administrators`, mandatory label `S:(ML;;NW;;;SI)`). DPAPI machine scope binds the blob to this machine, so a copied disk cannot unseal it on another host. The key is loaded into a `Zeroizing` buffer only to sign a challenge and is wiped after. It is **never** logged, exported, or sent on the wire (`device.key`, `*.privkey` added to the redact list, §14).

### 3.4 Device signaling and auth (`/signal`, binding)

The service holds one persistent WS to `signalUrl` (reconnect backoff as C §3.1). Device auth replaces `desk.hello`:

| `t` | Dir | Payload | Notes |
|---|---|---|---|
| `device.hello` | D→S | `{ deviceId, keyId, boot?: string, nonce: base64url(16), sig: base64url(Ed25519 over utf8("ia-dev-v1"||deviceId||serverChallenge||nonce)), client: { serviceVersion, agentVersion, osVersion, arch, capabilities: ServiceCapabilities, lanSegment: LanSegment, amt: AmtInventory\|null } }` | the socket first receives `device.challenge { serverChallenge: base64url(32), ts }` on upgrade; the service signs it with the device key; `boot` is sent only on the very first hello after enrollment and is `Presence.consume`d. Server verifies `sig` against `device.public_key` for `deviceId` (constant-time, A convention); failure → `error device_unauthenticated` + close `4412`; a `disabled` device → `error device_disabled` + close `4412`. |
| `device.hello.ok` | S→D | `{ deviceId, orgDisplayName, region, policy: UnattendedPolicy, groupId \| null, queued: QueuedAction[] (<= LIMITS.deviceQueueDrainMax) }` | the server marks `device.last_seen_at`, `last_ip`, `online` in presence (`ia:dev:<deviceId>` TTL 90 s refreshed by `device.heartbeat`), updates mutable facts (version, capabilities, lanSegment, amt) and returns any queued offline actions (§9) to drain |
| `device.heartbeat` | D→S | `{ lanSegment?, amt?, metrics?: { cpu, mem, uptimeSec } }` | every 30 s; refreshes presence TTL and `last_seen_at`; a changed `lanSegment`/`amt` updates the row (used by the waker mesh) |
| `device.challenge` | S→D | `{ serverChallenge, ts }` | sent once per socket before `device.hello`; a fresh challenge per socket prevents replay |

The upgrade is Origin-less (C §3.1 `deskOnly` generalised to `deviceOnly`): such a socket may send `device.hello`/`recorder.hello` and what follows, never `assist.hello`. A `device.hello` socket is registered as a **device presence**, distinct from a session Desk; it carries no session until the Assist opens one (§3.5). WS close codes gain **`4412 device_unauthenticated`/`device_disabled`** (terminal; the service retries `device.hello` with backoff, except after `device_disabled`, which pauses retries to `LIMITS.deviceDisabledRetrySec` = 3600).

### 3.5 Opening a session to a device (attended or unattended)

| Step | Who | Message / rule |
|---|---|---|
| 1 | Assist | `POST /api/v1/devices/:id/sessions { reason?, unattended: boolean, monitors?: number[] }` (RBAC §7); the server resolves the effective policy (§6), checks the Assist's seat tier covers `p4_installed`, and that the device is `online` (else `409 device_offline` with a hint to `POST /wake`, §8) |
| 2 | server | creates a `session` row (`tier = 'p4_installed'`, `assist_user_id` = caller, `desk_ref` = the device's current connection id, `device_id` set), writes `session.knock` + `session.accepted` in one step (no human knock from an unattended device; for an **attended** request the device prompts locally, §6.2), snapshots the effective policy onto the session (`session.unattended_policy`), and pushes `device.session_open { sessionId, assist: { name }, reason, unattended, policy, recordingMode }` to the device socket |
| 3 | device | the service launches `ia-desktop` into the correct session/desktop (§5.3), which shows the pill immediately and, per policy (§6.2), either auto-grants unattended consent (writing `session.unattended_started`) or shows a local approval prompt / waits for a logged-in user; then follows the C §3.3-§3.4 consent path (`desk.consent { native }` reused, `surface: 'monitor'`) |
| 4 | both | from `active` onward the session is a C §3 session: `session.created` to the Assist with ICE, `ia.sec`, the seven channels, video, input, playbooks, recorder. The Assist console is `AgentConsole` (C §13.4) with the P4 additions of §13.4 |

An unattended session **never** requires a human at the Desk when the policy allows it; the indicator is still drawn (P3). `POST /devices/:id/sessions` replaces the "knock/accept" of attended tiers for P4; the WS `assist.accept`/`assist.deny` path is not used for a device (there is no knock to accept).

### 3.6b Device presence, reconnect and multi-node

| # | Rule |
|---|---|
| 3.7a | A connected device is a **presence**, not a session: `ia:dev:<deviceId>` = `{ connectionId, nodeId, region }` TTL 90 s, refreshed by `device.heartbeat` (30 s); the owning `nodeId` is the node holding the socket. `GET /devices/:id` folds `online` from this entry. A device that misses its grace (90 s) is `offline` in the fleet view, not ended (it has no live session unless one is open) |
| 3.7b | Reconnect: the service reconnects `/signal` with C §3.1 backoff and re-runs `device.challenge`/`device.hello` (no bootstrap after the first); on reconnect it drains `device.hello.ok.queued` (§9) and re-reports `lanSegment`/`amt` so a moved machine's segment is current |
| 3.7c | Multi-node (A §7.6, `redis` driver): a `POST /devices/:id/*` that must reach the device socket is routed to the node holding it via the presence `nodeId` on the `node:<owner>` channel (the A bridge reused); `wake.send` / `device.action` / `device.session_open` are delivered by the owner node. The offline-queue, wake-attempt and device rows live in the region database (A T1); any node in the region serves the REST calls |
| 3.7d | A live P4 **session** follows the C/A owner model (`session.node_id` = the node that opened it); a desktop-switch rebuild (§5.3) keeps the session on its owner. If the device socket moves nodes mid-session (reconnect onto another node), the worker credential re-registration (§4.2) adopts the session like a C resume (A §7.6 adoption) |

### 3.6 Re-enrollment, supersede and rotation

| # | Rule |
|---|---|
| 3.6a | A device whose `hwFingerprint` matches an existing `enrolled` device in the org, enrolling with a new token, creates a **new** device row and marks the old one `superseded` (status enum value), writing `device.superseded { fromDeviceId, toDeviceId }`; the fleet view offers to merge tags/group. A re-image with a wiped key is thereby visible, not a silent duplicate. |
| 3.6b | Key rotation: `POST /api/v1/devices/:id/rotate-key` (org_admin) sets a one-time `rotation_nonce`; the device, on its next `device.hello`, may send `device.rotate { newPublicKey, newKeyProof, sig(old) }`; the server verifies both signatures and swaps `public_key`/`key_id`, audit `device.key_rotated { fromKeyId, toKeyId }`. |
| 3.6c | A `disabled` device is kept (audit history references it); `DELETE` is a soft delete (`status = 'retired'`, key invalidated), audit `device.retired`. Retired/disabled devices cannot `device.hello` (`4412`). |

---

## 4. The installed service and the desktop worker (Windows)

### 4.1 Service lifecycle

| Item | Binding |
|---|---|
| Install | service name `IndiansAssistAgent`, display "IndiansAssist Agent", `LocalSystem`, `SERVICE_AUTO_START`, delayed-auto-start off (it must be up before the logon screen for pre-login access), failure actions = restart after 5 s / 10 s / 60 s (`ia-service` registers these via `ChangeServiceConfig2`); a second service `IndiansAssistWatchdog` (§10) is `SERVICE_AUTO_START`, depends on nothing, and only watches |
| Crate | `ia-service` (`main.rs` as an SCM-aware binary via the `windows-service` crate, MIT/Apache-2.0): `SERVICE_CONTROL_STOP`/`SHUTDOWN`/`SESSIONCHANGE` handlers; on `WTS_SESSION_LOGON`/`UNLOCK`/`CONSOLE_CONNECT` it re-evaluates which desktop a live session should target (§5.3) |
| Logs | `%ProgramData%\IndiansAssist\logs\service.log` (rotating 5 × 1 MiB), the C §6 redaction applies (SDP/ICE/tokens/keys/clipboard/playbook output/secrets never logged) |
| Config | `%ProgramData%\IndiansAssist\config.json` (ACL `SYSTEM`+`Administrators`): `apiOrigin`, `signalUrl`, `deviceId`, `keyId` (never the key), waker-mesh opt-in, AMT opt-in; written at install from the sealed `enroll.iaconfig`, never from an untrusted location |
| Uninstall | the MSI uninstall stops both services, calls `POST /api/v1/devices/:id/deregister` with a signed statement (so the fleet shows "uninstalled", not "offline"), deletes the key blob, the config and the `%ProgramData%` tree (received files in a user's Downloads are kept) |

### 4.2 Service ↔ desktop-worker handoff (binding)

The service launches `ia-desktop` and hands it a session over a named pipe `\\.\pipe\IndiansAssist.svc.<32 random hex>` created by the service with `FILE_FLAG_FIRST_PIPE_INSTANCE | PIPE_REJECT_REMOTE_CLIENTS` and a DACL granting `SYSTEM` and the launched worker's user SID only; the service verifies the client pid equals the process it launched and the image path equals its own `%ProgramFiles%` install path (same family as C §7.2). It writes one JSON blob `{ v: 1, sessionId, apiOrigin, signalUrl, assist: { name }, unattended: boolean, policy, consent: { level, monitors, clipboard }, recordingMode, gen: 0, deviceId, secureDesktop: boolean, tokenless: true }` then holds the pipe open for the session (duplex: the worker streams `ia.sec`-independent control such as desktop-switch requests and the service streams `SESSIONCHANGE` notifications back). The worker does **not** connect `/signal` itself; the service relays the worker's `desk.*`/`ctl`/channel traffic? No — to reuse the Phase C code unchanged, the **worker holds its own `/signal` socket** authenticated by a per-session **worker credential** the service obtains with `POST /api/v1/devices/:id/sessions/:sid/worker-credential` (a short-lived signed blob bound to the session and device, 120 s, single-use) and passes in the blob; the worker presents it as `desk.hello { token: <workerCredential>, client.kind: 'native', ... }` and the server treats a valid worker credential exactly like a C resume onto the already-open session (W31: the worker credential is the device analogue of C's hand-over token, so the C §7.2 "register as Desk" machinery is reused without a second code path). This keeps `ia-agent`'s serve loop byte-for-byte.

### 4.3 Reusing the Phase C agent

`ia-desktop` **is** the Phase C `ia-agent` serve loop with three seams replaced through the `ia-platform` traits and the launch blob:

| Seam | Phase C | Phase D |
|---|---|---|
| Token source | C §2.1 carriers | the launch blob's worker credential only (§4.2) |
| Consent source | C §3.3 window / `--auto-consent` | the policy decision in the blob (§6.2): unattended → auto-grant + receipt; attended-with-user → local prompt |
| Capture target | the signed-in user's desktop | the desktop the service selected (console session, or the secure/logon desktop, §5.3) |

Elevation hand-over (C §7) is **not used** in P4: the worker is already `LocalSystem` (or runs on the secure desktop), so admin windows and the UAC desktop are reachable without a relaunch. The console's "Request elevation" becomes "Request privileged mode" and simply sets `session.consent_level = 'elevated'` after the policy/approval check (§5.2), with no process relaunch; `elevation.request` on `ia.control` is answered by raising the level in place (W32).

---

## 5. Service-grade capabilities (the C §7.4 / W9 deferrals)

### 5.1 Secure-desktop and lock-screen capture (binding)

| # | Rule |
|---|---|
| 5.1a | Because `ia-desktop` can run as `LocalSystem` on the input desktop, DXGI Desktop Duplication captures the **secure desktop** (UAC consent, the logon screen, Ctrl+Alt+Del) and the **lock screen**; C §4.1's "secure desktop delivers nothing" limit is lifted for P4 (`ctl.event capture { cause: 'secure_desktop' }` is no longer sent as a dead-frame signal; instead the worker switches its capture to the secure desktop, §5.3) |
| 5.1b | The worker enumerates and selects desktops with `OpenInputDesktop`/`SetThreadDesktop`; on a `WTS_SESSION_LOCK`/secure-desktop transition the service notifies the worker, which re-points capture and input at `Winlogon`/`Secure Desktop` and forces a keyframe; the console shows "User is at the Windows sign-in / security screen" (informational, no longer a block) |
| 5.1c | Capturing the logon/secure desktop is itself a privileged, sensitive action: it is allowed only when `session.consent_level === 'elevated'` **and** the effective policy's `allowSecureDesktop` is true (default **false**); otherwise the worker holds the last pre-secure-desktop frame and shows "Windows security screen (hidden by policy)". Every secure-desktop capture window writes `capture.secure_desktop { durationMs }` (desk) so it is on the record |

### 5.2 Service-grade input and privileged mode

| # | Rule |
|---|---|
| 5.2a | Input injection runs in the worker on the input desktop, so `SendInput` survives UAC dialogs and reaches the secure desktop; UIPI never blocks it (same-or-higher integrity). `Ctrl+Alt+Delete` (the SAS) still cannot be injected by any process (C §5.4); the console shows a **Send Ctrl+Alt+Del** button that calls a privileged action (`os.sas`, §5.4) the service performs via `SendSAS` (the standard service-only API), gated on `elevated` + policy |
| 5.2b | "Privileged mode" (the P4 name for C's elevation) is reached by `elevation.request { reason }` on `ia.control`; the server/worker check the effective policy's `allowPrivileged` and, when the policy requires approval and a user is present, the local approval prompt; on success `session.consent_level → 'elevated'` **with no process relaunch** (W32), audit `elevation.granted { elevation: 'admin', claimed: true, mode: 'service' }`. Dropping back to `control`/`view` re-imposes the input/feature restrictions by policy (C §3.4 lower rule reused) |

### 5.3 Desktop selection state (binding)

The service drives which desktop the worker targets:

| Machine state | Target desktop | Worker token |
|---|---|---|
| A user is logged in and at the console (unlocked) | `WinSta0\Default` of the console session | `WTSQueryUserToken(consoleSessionId)` → `CreateProcessAsUser` |
| Locked, or at the logon screen, or no user logged in (pre-login) | `WinSta0\Winlogon` (secure/logon desktop) | `LocalSystem` duplicated onto the secure desktop (allowed only under §5.1c policy) |
| A UAC prompt is up (secure desktop) | the secure desktop | as above |
| Fast-user-switch / RDP session change | re-evaluate on `WTS_SESSION_*` | the service kills and relaunches the worker for the new session, preserving the session (a C §3.7 rebuild with `gen+1`, new SAS the console re-confirms) |

### 5.4 Input lock and privacy screen (binding; `os.input_lock`, `os.privacy_screen` now supported)

C §5.1 defined these as `not_supported { message: 'phase_d' }`. In P4 they are supported:

| `op` | `args` | `result` | Min level | Audit |
|---|---|---|---|---|
| `os.input_lock` | `{ locked: boolean }` | `{ locked }` | `elevated` | `input.lock_changed { locked }` (desk) |
| `os.privacy_screen` | `{ on: boolean }` | `{ on }` | `elevated` | `privacy_screen_changed { on }` (desk) |
| `os.sas` | `{}` | `{}` (sends Ctrl+Alt+Del via `SendSAS`) | `elevated` | `control.input { kinds: ['key'], count: 1 }` |

Input lock blocks the local physical keyboard/mouse while the technician works (a low-level block the service can enforce because it owns the input desktop, `BlockInput` in the worker plus a visible "Input locked by <technician>" banner that the sitting user can always break with Ctrl+Alt+Del, which the service un-locks on); privacy screen blanks the physical monitors to a branded "Maintenance in progress" overlay while the stream continues. Both are policy-gated (`allowInputLock`, `allowPrivacyScreen`, default **false**) and both are released on teardown, level drop, session end and worker crash (fail-open to the user). The console `AgentStats`/`InputModeToggle` show the live state; the pill shows a lock/privacy glyph.

### 5.5 Honest limits that remain

| Limit | Note |
|---|---|
| The SAS keystroke still cannot be *injected* | only `SendSAS` from the service triggers it; injecting `Ctrl+Alt+Del` is impossible by OS design (C §5.4), so `os.key` still answers `not_supported { message: 'sas' }` for that combination |
| BitLocker pre-boot PIN / firmware password screens | before Windows loads, only AMT SOL (§8.3) can interact; the service is not running yet |
| A machine that is fully off | needs WoL or AMT power-on first (§8); the service cannot capture what is not booted |

---

## 6. Unattended policy and consent (PRD 7)

### 6.1 `UnattendedPolicy` (shared `fleet/policy.ts`, strict)

```json
{ "mode": "allow", "requireLocalApprovalWhenPresent": true, "allowedHours": { "tz": "Asia/Kolkata", "windows": [{ "days": [1,2,3,4,5], "from": "09:00", "to": "18:00" }] } | null,
  "recordingRequired": true, "allowSecureDesktop": false, "allowPrivileged": true, "allowInputLock": false, "allowPrivacyScreen": false,
  "notifyLocalUser": true, "maxUnattendedMinutes": 120 }
```

| Field | Rule |
|---|---|
| `mode` | `UNATTENDED_MODES = ['allow', 'approval_only', 'deny']`: `allow` = unattended entry permitted (subject to hours); `approval_only` = a local human must approve each session (so not truly unattended — used for sensitive groups); `deny` = no unattended entry, a logged-in user must grant consent exactly as C |
| `requireLocalApprovalWhenPresent` | when a user **is** logged in, prompt them even if `mode = allow` (do not take over a machine someone is using without a nod); when nobody is present, `allow` proceeds |
| `allowedHours` | null = any time; otherwise unattended entry outside the windows answers `409 outside_policy_window` |
| `recordingRequired` | when true the session forces `recordingMode` to at least `server` (A.2) and refuses to start if the recorder cannot be assigned (`409 recorder_required`) |
| `allowSecureDesktop` / `allowPrivileged` / `allowInputLock` / `allowPrivacyScreen` | per-capability gates (§5) |
| `notifyLocalUser` | show the pill + a toast "IndiansAssist session started by <technician>" even when nobody approved (consent-visible, P3); cannot be turned off below the pill itself — this only controls the extra toast |
| `maxUnattendedMinutes` | the session auto-ends with `endReason = 'policy_timeout'` after this many minutes of a purely unattended (no local user) session; 0 = no cap |

`resolveUnattendedPolicy` merges device-override over group over org default; the org default ships as `{ mode: 'approval_only', requireLocalApprovalWhenPresent: true, recordingRequired: true, allowSecureDesktop: false, allowPrivileged: true, allowInputLock: false, allowPrivacyScreen: false, notifyLocalUser: true, maxUnattendedMinutes: 120 }` (safe by default: approval required until an admin opts a group into `allow`).

### 6.2 Consent decision at session open (binding)

| Situation | What the worker does |
|---|---|
| `mode = deny` | wait for a logged-in user and run the C §3.3 consent window; if nobody is present, `desk.consent` is never sent and the session times out `consent_required` → `session.ended { endReason: 'consent_required' }` |
| `mode = approval_only`, user present | show a local approval card (technician, org, reason, "Allow this remote session") with **Allow**/**Decline**, physical-input gated (C §3.5); Allow → `desk.consent { native }` + `session.unattended_started { approvedBy: 'local_user' }` |
| `mode = approval_only`, nobody present | `409 approval_required` is returned to the Assist at `POST /sessions` time (the session is not created); the console shows "This group requires someone at the device to approve" |
| `mode = allow`, user present, `requireLocalApprovalWhenPresent` | approval card as above, but with a 30 s auto-allow countdown only if the policy sets `autoAllowAfterSec` (not shipped by default) |
| `mode = allow`, nobody present (or present and approval not required) | auto-grant: the worker sends `desk.consent { native: { level: 'control', monitors: [all], clipboard: false } }` immediately, writes `session.unattended_started { approvedBy: 'policy', policySnapshot }`, and shows the pill + (if `notifyLocalUser`) the toast |

In every case the pill, tray and recording dot are drawn (P3) and the consent receipt (C §3.5, PRD 12.14) is produced at session end and, for unattended sessions, also **emailed to the device's configured owner/notify address** when the group has one (`device_group.notify_email`), so an absent user still gets a record of what happened on their machine.

### 6.3 Audit for unattended

New actions (§3.8): `session.unattended_started`, `device.session_open` is not chained (it is a push), `capture.secure_desktop`, `input.lock_changed`, `privacy_screen_changed`. The `session_end_reason` enum gains `policy_timeout` and `consent_required` is reused.

---

## 7. Fleet management (REST, RBAC, audit)

### 7.1 Roles

The A §2.2 roles are reused. New capability rows (A §2.3 matrix extended, §16):

| Capability | technician | senior_technician | org_admin | auditor | observer |
|---|---|---|---|---|---|
| devices list / get | own-group* | org | org | org | org (no live actions) |
| device session open (`POST /devices/:id/sessions`) | own-group | org | org | no | no |
| device wake (`POST /devices/:id/wake`) | own-group | org | org | no | no |
| device script/action run | own-group | org | org | no | no |
| device enroll config / MSI download | no | no | org_admin | no | no |
| device disable / retire / rotate-key | no | no | org_admin | no | no |
| groups + policy CRUD | no | no | org_admin | no | no |
| offline queue list | own-group | org | org | org | no |
| fleet residency counts | no | no | org_admin | auditor | no |

\* "own-group" = devices in a group the technician is assigned to via `user.device_group_ids` (a new nullable array on `user`; empty = all groups in org for backward compatibility with small orgs, configurable by org_admin). Cross-org device id → `404 not_found` (A §2.3). An own-group failure within the org → `403 forbidden`.

### 7.2 Endpoints (`apps/api/src/fleet/*`)

| Method / path | Roles | Request | Response |
|---|---|---|---|
| `GET /api/v1/devices` | per §7.1 | `?group=&tag=&status=&online=&q=&limit&cursor` | `200 Page<Device>` (§13.1 wire); `online` folded from presence; cursor `<lastSeenAt>\|<id>` |
| `GET /api/v1/devices/:id` | scope | | `200 Device & { group, policy: UnattendedPolicy (effective), amt: AmtInventory \| null, recentSessions: SessionSummary[] }` |
| `PATCH /api/v1/devices/:id` | org_admin | `{ name?, groupId?, tags?, unattendedPolicy?: Partial<UnattendedPolicy> \| null, notifyEmail? }` | `200 Device`; `(id, org_id)` load, 404 cross-org; audit `device.updated { fields }` |
| `POST /api/v1/devices/:id/disable` / `/enable` | org_admin | | `200 Device`; disable closes the device socket `4412`, ends any live session (`token_revoked`→`device_disabled` reason), refuses new sessions; audit `device.disabled`/`device.enabled` |
| `DELETE /api/v1/devices/:id` | org_admin | | `204` soft retire (§3.6c); audit `device.retired` |
| `POST /api/v1/devices/:id/rotate-key` | org_admin | | `200 { rotationArmed: true }`; audit `device.key_rotation_armed` |
| `POST /api/v1/devices/:id/sessions` | scope | `{ reason?, unattended: boolean, monitors? }` | `201 { sessionId }` or `409 device_offline` / `approval_required` / `outside_policy_window` / `recorder_required` (§3.5, §6); audit `session.accepted` + (on start) `session.unattended_started` |
| `POST /api/v1/devices/:id/wake` | scope | `{ method?: 'wol' \| 'amt' \| 'auto' (default auto) }` | `202 { wakeId, method, via }` (§8); audit `device.wake_requested { method, via }` |
| `POST /api/v1/devices/:id/actions` | scope | `{ kind: DeviceActionKind, payload }` (§9) | `202 { actionId, state: 'queued' \| 'dispatched' }`; audit `device.action_queued` |
| `GET /api/v1/devices/:id/actions` | scope | `?state&limit&cursor` | `200 Page<DeviceAction>` |
| `POST /api/v1/devices/:id/actions/:actionId/cancel` | scope | | `200 DeviceAction`; audit `device.action_cancelled` |
| `GET/POST/PATCH/DELETE /api/v1/orgs/current/device-groups[/:id]` | org_admin (GET any device-scope role) | group + default policy + tags + notifyEmail | `200/201/204`; audit `device_group.created/updated/deleted` |
| `GET/PATCH /api/v1/orgs/current/policy/unattended` | org_admin (GET any role) | the org default `UnattendedPolicy` | `200`; audit `org.policy_updated { fields: ['unattended'] }` (B naming reused) |
| `GET /api/v1/devices/enroll-config` | org_admin | `?tokenId=&groupId=` | `200 { iaconfig: string (signed enroll.iaconfig) }` for the MSI transform (§12.3); audit `device.enroll_config_issued { tokenId, groupId }` |
| `GET /api/v1/orgs/current/residency` | org_admin, auditor | | extended (A §6.3) with `devices`, `onlineDevices`, `unattendedSessions30d`, `wakeAttempts30d`, `deviceActions30d` |

All device-scoped routes use `scopedDevice(ctx, p, id)` (the A `scopedSession` analogue: `(id, org_id = p.org.id)` load else 404, then the §7.1 group/role check else 403).

### 7.3 RBAC summary

Device create happens only through enrollment (§3.2), never a REST POST. Everything mutating policy, groups, enable/disable/retire/rotate is org_admin. Running a session, waking, and queueing actions follow the own-group/org split. Auditor is read-only across the fleet. Observer sees the device list and status but can take no live action and sees no audit export.

---

## 8. Wake on LAN, the waker mesh, and AMT power-on (PRD 12.5, 15.3)

### 8.1 Wake resolution (`POST /devices/:id/wake`, binding)

| Step | Rule |
|---|---|
| W1 | `method: 'auto'` tries, in order: (1) AMT if the device's `amt.provisioned` is true and AMT is reachable (§8.3), (2) WoL via a waker peer (§8.2); `method: 'wol'`/`'amt'` force one path. The target device itself is offline (that is why it needs waking), so the server acts through other online devices or the AMT management path |
| W2 | The server records a `wake_attempt` row (`wakeId`, method, via, state `pending`), returns `202 { wakeId, method, via }`, and resolves asynchronously; the console polls `GET /devices/:id` (presence flips to online when the woken device's service reconnects) or subscribes to the `device.woke` push |
| W3 | Success = the target `device.hello`s within `LIMITS.wakeConfirmSec` (120); the attempt is marked `woke`, audit `device.woke { wakeId, method, via, elapsedMs }`. No reconnect in the window → `failed { cause: 'no_confirm' }` (the magic packet or AMT command was sent but the machine did not come up; honest, P8) |

### 8.2 LAN waker mesh (binding)

| # | Rule |
|---|---|
| 8.2a | Every online P4 device reports a **`LanSegment`** in `device.hello`/`device.heartbeat`: `{ subnetHash: hex (sha256 of the device's IPv4 /24 CIDR + the default-gateway MAC, computed locally so raw addresses need not be sent), gatewayMacHash: hex, dhcpDomain?: string }`. Devices sharing a `subnetHash` are a **segment**; the server groups them in presence (`ia:seg:<subnetHash>` → set of online deviceIds) |
| 8.2b | To WoL a target, the server reads the target's last-known `subnetHash` (stored on the row at each heartbeat, `device.lan_segment`), finds an online device in that segment advertising the `waker` capability, and pushes `wake.send { wakeId, targetMac: <the target device's stored MAC hash is not enough — see 8.2c>, targetMacEnc }` to it; the waker emits the magic packet to the broadcast address and replies `wake.sent { wakeId, ok }` |
| 8.2c | **MAC handling:** the target's real MAC is needed to build the magic packet but must not sit in the clear in the DB. The device reports its own MAC **encrypted to the org's waker key** (a per-org symmetric key the server holds, `device.mac_enc`), and the server passes `targetMacEnc` to the chosen waker which decrypts it with the org waker key the service also holds (delivered sealed at enrollment). The DB stores only `mac_enc` and a `mac_hash` for de-dup; a plaintext MAC never lands in a row or a log (W33) |
| 8.2d | `waker` is opt-in per org (`org.waker_mesh_enabled`, default true) and per device (a device may decline the role in its config); a segment with no online waker returns `failed { cause: 'no_waker' }` and the console suggests AMT or asking someone to turn the machine on |
| 8.2e | A waker only ever sends a magic packet (a UDP broadcast of the target MAC); it receives no other authority over its peers and the `wake.send` push is signed into the audit as `device.wake_dispatched { wakeId, viaDeviceId }` so the mesh is on the record |

### 8.2b Wake sequence (end to end, WoL path)

| Step | Who | Action |
|---|---|---|
| 1 | Assist | `POST /devices/:id/wake { method: 'auto' }` → `202 { wakeId, method: 'wol', via: <wakerDeviceId> }` after the server elects a waker |
| 2 | server | writes `wake_attempt` (`pending`), `device.wake_requested`; finds an online `waker`-capable device in the target's `lan_segment`; pushes `wake.send { wakeId, targetMacEnc }` to it (routed by node, §3.7c); state → `dispatched`, `device.wake_dispatched { wakeId, viaDeviceId }` |
| 3 | waker | decrypts `targetMacEnc` with the org waker key, broadcasts the magic packet (UDP 9 to the subnet broadcast), replies `wake.sent { wakeId, ok: true }` |
| 4 | target | powers on, the service boots, `device.hello`s within `wakeConfirmSec` (120) |
| 5 | server | matches the reconnect to `wakeId`, marks `woke`, writes `device.woke { wakeId, method: 'wol', via, elapsedMs }`, pushes `device.woke` to any watching console |
| — | failure | no online waker → `202` is still returned with `via: null` and the attempt immediately `failed { cause: 'no_waker' }`; no reconnect in the window → `failed { cause: 'no_confirm' }`; both are shown honestly (P8) |

### 8.3 AMT / vPro power-on (self-hosted, hardware gated, v1)

| # | Rule |
|---|---|
| 8.3a | `AmtInventory` (reported at enrollment and heartbeat) `= { present: boolean, provisioned: boolean, version?: string, host?: string (the AMT firmware's own IP/FQDN), tls: boolean, powerState?: int }`. `present` = the firmware exists; `provisioned` = it has been set up for our management (admin credentials in the vault, §8.3c). The fleet view shows "Cold power on: available" only when `present && provisioned` (PRD 15.3) |
| 8.3b | Power-on runs through `ia-waker`'s AMT client (`ia_waker::amt`) on a device elected as the segment's **AMT proxy** (an online P4 device on the same subnet that can reach the target's AMT host on port 16992/16993), or, where the deployment runs a dedicated in-region **AMT gateway** (`services/amt`, optional, not built here — a hook), through that. The command set is power-on (`RemoteControl`/`ChangeSystemPowerState` to S0), optional boot-device redirect, and **Serial-over-LAN** console (surfaced as a read-only text console in the fleet view for pre-boot diagnostics). No Intel cloud dependency (PRD 15.3) |
| 8.3c | AMT admin credentials are **never** stored on a device or in a device row; they live in the org's credential vault (§12-vault / OpenBao) and are injected into the AMT proxy for one command then wiped. Audit `device.amt_poweron { wakeId, viaDeviceId }` / `device.amt_sol_opened`. CIRA/TLS to AMT uses the device/firmware certificate; plain HTTP AMT (port 16992) is allowed only on a trusted LAN segment and flagged in the residency report |
| 8.3d | Hardware/firmware variance is wide; `ia_waker::amt` targets AMT ≥ 11 over the standard WS-Management (`/wsman`) interface; unprovisioned or unreachable firmware returns `failed { cause: 'amt_unreachable' }` and the UI stays honest (P8) |

---

## 9. Offline action queue (PRD 12.12)

| # | Rule |
|---|---|
| 9.1 | `POST /devices/:id/actions { kind, payload }` queues an action for a device. `DeviceActionKind = ['playbook_run', 'file_push', 'print', 'message']`. If the device is **online** the server dispatches it at once over the device socket (`device.action { actionId, kind, payload }`); if **offline** it is stored `queued` and delivered in `device.hello.ok.queued` on next check-in (§3.4) and also pushed if the device comes online meanwhile |
| 9.2 | Table `device_action` (§13.2): `id`, `org_id`, `device_id`, `created_by`, `kind`, `payload jsonb`, `state` (`queued`, `dispatched`, `running`, `done`, `failed`, `cancelled`, `expired`), `reason`, `result jsonb`, `expires_at` (default now + 7 days), `dispatched_at`, `completed_at`, timestamps. An action older than `expires_at` is swept to `expired` |
| 9.3 | `playbook_run` payload = `{ playbookId, args, requiresElevation }` validated exactly as C §8 (the body is pinned and delivered the same way; the device verifies the hash against the manifest it holds, which the service refreshes on each `device.hello`). A queued privileged action runs only if the effective policy's `allowPrivileged` is true **and** the device is at an interactive state the policy permits; otherwise it fails `policy` |
| 9.4 | `file_push` payload = `{ fileRef, name, bytes, sha256 }` where `fileRef` is a short-lived object-store presign (A §9, MinIO/S3); the device streams it to `%ProgramData%\IndiansAssist\pushes\` with MOTW (C §6.1 F3 rules) and reports `done` with the written path; it is **never** auto-executed (C §6.1 F4) |
| 9.5 | `print` payload = `{ fileRef, name, printer?: string }` (PRD remote printing): the device fetches the document and prints it to the named or default printer via the OS print spooler through a signed built-in playbook (`__ia_print`), reporting pages/exit; policy-gated by `allowPrivileged` only when a non-default printer or driver action is needed |
| 9.6 | `message` payload = `{ title, body }` shows a toast/notification to whoever is at the device (useful for "we will connect shortly"); no policy gate; never executes anything |
| 9.7 | Every state transition is audited: `device.action_queued`, `device.action_dispatched`, `device.action_completed { kind, state, exit? }` (actor desk for the completion, reported by the device over `device.action_result { actionId, state, result }`, a new D→S message, validated and chained). Output content of a `playbook_run` is never chained (C §8.5); only exit/duration/ranAs |

---

## 10. Self-healing and tamper-alerting agent (PRD 12.13)

| # | Rule |
|---|---|
| 10.1 | **Watchdog.** `IndiansAssistWatchdog` (a second service) plus a **scheduled task** `IndiansAssist Watchdog` (`LocalSystem`, trigger: at startup + every 5 min) both check that `IndiansAssistAgent` is `RUNNING` and that its binary's Authenticode signature and sha256 match the installed manifest; if the service is stopped/disabled/missing they attempt one restart (or re-register from the preserved MSI cache) and record a local `tamper.local` event with a cause (`stopped`, `disabled`, `deleted`, `binary_changed`, `config_changed`) |
| 10.2 | **Backfill + alert.** Local tamper events are buffered (`%ProgramData%\IndiansAssist\tamper.log`, signed with the device key so they cannot be forged by a non-admin) and sent as `device.tamper { events: TamperEvent[] }` on the next `device.hello`; the server writes `tamper.alert { cause, at, detail }` to the chain (actor device, written by the server) and marks `device.tamper_state` so the fleet view flags the device red. A device that the server knows was online and goes **silent past its heartbeat grace while an admin disabled nothing** is flagged `tamper_suspected` after `LIMITS.tamperSilentGraceSec` (900) and surfaced, so a killed agent is visible rather than an innocent "offline" (P7) |
| 10.3 | **Integrity self-check.** On each start and every hour the service runs the C §2.6 `WinVerifyTrust` + `IA_EXPECTED_SIGNER` check on its own and the worker's binary and compares the import table against the KnownDLLs gate's expectation (C §11.3); a mismatch raises `tamper.local { cause: 'binary_changed' }` and refuses to spawn the worker until repaired |
| 10.4 | **Config and key protection.** The key blob, config and manifest live under `%ProgramData%\IndiansAssist\` with `SYSTEM`+`Administrators` ACLs and a high mandatory label (§3.3); a change to config or manifest hash raises `config_changed`. These are speed bumps against a local admin (who can, by definition, stop a service they own); the value is **visibility** — every such change is on the tamper-evident chain and in the fleet view, which is the PRD's claim (an attacker can disable the agent, but not silently) |
| 10.5 | `TamperEvent = { cause: TAMPER_CAUSES, at: ISO, detail?: string, sig: base64url(device key over the event) }`; `TAMPER_CAUSES = ['stopped', 'disabled', 'deleted', 'binary_changed', 'config_changed', 'watchdog_restarted', 'tamper_suspected']`. The fleet view's device badge reads from `device.tamper_state` (`ok`, `alerted`, `suspected`) with a clear/acknowledge action (org_admin, audited `tamper.acknowledged`) |

---

## 11. Service architecture and build (Rust)

### 11.1 New crates (extend C §11.1)

| Crate | Owns | Depends on | Platform |
|---|---|---|---|
| `ia-service` | the SCM binary: identity (key gen, DPAPI seal/unseal), enrollment client, persistent `/signal` device socket + device-auth, unattended-policy decision, worker supervision + the §4.2 handoff pipe, offline-queue drain, waker/AMT dispatch, vault client, watchdog registration, `SESSIONCHANGE` handling and desktop selection | `windows`, `windows-service`, `ia-core`, `ia-platform`, `tokio`, `tokio-tungstenite`, `ed25519-dalek`, `zeroize` | windows (service) |
| `ia-session0` | `WTSQueryUserToken`, `CreateProcessAsUser`, desktop enumeration/switching (`OpenInputDesktop`/`SetThreadDesktop`), secure-desktop targeting, the service↔worker pipe protocol; pure name/DACL/desktop-selection logic is unit-tested, the Win32 behind `winapi` | `windows`, `ia-platform` | windows |
| `ia-waker` | magic-packet builder/sender, segment math, MAC encrypt/decrypt with the org waker key, the AMT WS-Management client (`amt`), SOL plumbing; the packet and segment math is pure and tested | `windows` (sockets), `ureq`/`hyper`+rustls (AMT WS-Man), `ia-platform` | windows (sockets portable; AMT portable) |
| `ia-vault` | OpenBao/Vault client (AppRole auth, read-only secret fetch, injection into a child's environment, never to the console), for AMT credentials and `requiresElevation` playbooks that reference a vault path | `ureq`/`hyper`+rustls, `zeroize` | portable |
| `ia-desktop` | the P4 desktop worker = the Phase C `ia-agent` serve loop with the §4.3 seams; a thin `main.rs` that reads the handoff blob and runs the C loop | all C agent crates + `ia-session0` | windows |

`ia-platform` gains traits `ServiceHost`, `DesktopBridge`, `Waker`, `Amt`, `VaultClient` so the Phase E macOS/Linux daemons fill the same seam.

### 11.2 Crates/tools added (licences in `docs/LICENSE-REGISTER.md`)

| Component | Licence | Use |
|---|---|---|
| `windows-service` | MIT OR Apache-2.0 | Windows SCM integration (`ia-service`, `ia-watchdog`) |
| `windows` crate (already in C) | MIT OR Apache-2.0 | WTS, desktop, DPAPI (`crypt32`), AMT sockets, SCM config |
| **WiX Toolset v5** (installed as the .NET global tool `wix`) | **Microsoft Reciprocal License (MS-RL)** — used only as an unmodified build tool to compile our `.wxs` into an MSI; no WiX source is copied into our code and nothing of WiX ships inside the MSI payload beyond the standard MSI/CustomAction runtime it emits | builds the signed MSI (`packaging/windows/`, §12.2); invoked in CI via `dotnet tool`; added to the licence register under "build tools, not shipped" |
| OpenBao (or HashiCorp Vault) | OpenBao: MPL-2.0 (run as an unmodified separate service over its HTTP API, nothing linked/copied) | credential vault for AMT creds and privileged-playbook secrets; self-hosted service, same posture as Garage/Keycloak in the register |
| `ia-vault` HTTP via existing `ureq`/`hyper` + `rustls` (C §11.2) | — | no new TLS stack |

No new web dependency. The AMT WS-Management XML is handled with `quick-xml` (MIT) if a parser is needed, added to the register if used.

### 11.3 Build, size, signing

The MSI payload bundles the signed `ia-service.exe`, `ia-desktop.exe` (the C `ia-agent` renamed for the install), `ia-watchdog.exe`, and the shared system-DLL late-binding of C §11.3 (the import-table KnownDLLs gate applies to all three binaries). CI targets `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc`, `cargo build --release --locked`, Authenticode SHA-256 + timestamp on every exe and on the MSI, and the C §11.3 size/import gates per exe. `docs/release.md` gains the P4 MSI build and signing steps. The service binaries are **not** self-deleting (they are installed, not portable); C §10 self-delete is disabled in the P4 build.

### 11.4 Threading / IPC

Each process keeps the C §11.4 model (one tokio multi-thread runtime; capture/encode on dedicated threads in the worker). The service↔worker pipe and the device `/signal` socket are on the service's runtime; the worker holds its own runtime and its own `/signal` socket (§4.2). No blocking Win32 call runs on a runtime worker.

---

## 12. Mass deployment (PRD 3, 4, 5)

### 12.1 Channels

| Channel | Binding |
|---|---|
| **MSI + GPO** | a single signed MSI (per arch) installs the service; an org-specific **MST transform** (or MSI property) carries the signed `enroll.iaconfig` so one base MSI serves every org; deployed by Group Policy Software Installation or a startup script |
| **Intune** | the same MSI wrapped as `.intunewin` (or the MSI directly), assigned to a device group; enrollment config passed as an install command-line property `IA_ENROLL=<base64url signed enroll.iaconfig>` |
| **Manual** | an org_admin downloads the branded MSI from the tokens/fleet page (carrying the transform) and runs it; used for pilots |
| **deb/rpm + Ansible, PKG + MDM** | **Phase E** (§1.2); the packaging layout leaves room (`packaging/{linux,macos}/`) but ships nothing in Phase D |

### 12.2 MSI build (`packaging/windows/`, WiX)

| Item | Rule |
|---|---|
| Tool | WiX v5 as a .NET global tool (`dotnet tool install --global wix`); CI runs `wix build` over `packaging/windows/IndiansAssist.wxs`; no WiX binaries are checked in or shipped |
| Install | per-machine (`ALLUSERS`), `%ProgramFiles%\IndiansAssist\`, registers the two services and the scheduled task, writes `config.json` from the `IA_ENROLL` property / `enroll.iaconfig`, sets the ACLs of §3.3/§10.4 via a custom action that runs as `LocalSystem` at install |
| Branding | org name/logo in the ARP (Add/Remove Programs) entry and the install UI come from the transform; the installer never phones home during install — enrollment happens on first service start (§3.1) |
| Signing | the MSI and every embedded exe are Authenticode-signed in CI (same identity as C §2.6); `IA_EXPECTED_SIGNER` is compiled into the binaries and checked at runtime (§10.3) |
| Upgrade | a MajorUpgrade with `Schedule="afterInstallExecute"`; the device identity, key and config under `%ProgramData%` survive an upgrade (only `%ProgramFiles%` binaries are replaced); the service re-reads its manifest after upgrade |
| Uninstall | §4.1 (deregister, wipe key/config) |

### 12.3 `enroll.iaconfig` (signed)

A UTF-8 JSON file (`<= LIMITS.enrollConfigMaxBytes` = 16384) placed by the MSI next to `ia-service.exe`, strict shape, **signed** by the region's token-signing key (C §2.4 reused): `{ v: 1, apiOrigin, signalUrl, region, token: "<enrollment compact token>", groupId?: uuid, kid, sig }`. The service verifies `sig` against the compiled `IA_REGION_PUBKEYS` (C §2.4), enrolls (§3.1), then shreds the file (the enrollment token is single-use anyway, W30). `GET /api/v1/devices/enroll-config` (org_admin, §7.2) mints it for the tokens page.

---

## 13. Shared, DB, and console additions

### 13.1 Shared (`packages/shared`, name index)

| File | Exports (new) |
|---|---|
| `enums.ts` | `UNATTENDED_MODES`, `DEVICE_PLATFORMS` (`windows`,`macos`,`linux`), `DEVICE_STATUSES` += `superseded`,`retired` (A had `enrolled`,`disabled`), `DEVICE_ACTION_KINDS`, `DEVICE_ACTION_STATES`, `TAMPER_CAUSES`, `TAMPER_STATES`, `WAKE_METHODS` (`wol`,`amt`,`auto`), `WAKE_STATES`, `SERVICE_FEATURES` (= `AGENT_FEATURES` + `secure_desktop`,`service_input`,`input_lock`,`privacy_screen`,`waker`,`amt`,`sas`); `WS_CLOSE.deviceUnauthenticated = 4412`; `session_end_reason` += `policy_timeout`; `LIMITS` additions (below) |
| `fleet/device.ts` | `deviceSchema`/`Device` wire, `serviceCapabilitiesSchema`/`ServiceCapabilities`, `amtInventorySchema`/`AmtInventory`, `lanSegmentSchema`/`LanSegment`, `deviceEnrollRequestSchema`, `deviceEnrollReplySchema`, `hwFingerprint` rules |
| `fleet/policy.ts` | `unattendedPolicySchema`/`UnattendedPolicy`, `UNATTENDED_MODES`, `resolveUnattendedPolicy`, `DEFAULT_UNATTENDED_POLICY`, `isWithinPolicyWindow(policy, now)` |
| `fleet/actions.ts` | `deviceActionSchema`/`DeviceAction`, per-kind payload schemas (`playbookRunActionSchema`, `filePushActionSchema`, `printActionSchema`, `messageActionSchema`), `deviceActionResultSchema` |
| `fleet/wake.ts` | `wakeRequestSchema`, `wakeReplySchema`, `wakeAttemptSchema` |
| `fleet/tamper.ts` | `tamperEventSchema`/`TamperEvent`, `TAMPER_CAUSES`, `deviceTamperSchema` (the D→S batch) |
| `schemas/signal-device.ts` | `deviceChallengeSchema`, `deviceHelloSchema`, `deviceHelloOkSchema`, `deviceHeartbeatSchema`, `deviceSessionOpenSchema`, `deviceActionPushSchema`, `deviceActionResultSchema`, `deviceTamperSchema`, `deviceWokeSchema`, `wakeSendSchema`, `wakeSentSchema`, `deviceRotateSchema`; the three signal unions include them; `DEVICE_CLIENT_TYPES`; server types += `device.challenge`, `device.session_open`, `device.action`, `wake.send`, `device.woke` |
| `schemas/rest-fleet.ts` | all §7.2 request/response schemas; `Device`/`DeviceAction`/`SessionSummary` wire objects; residency extension |
| `schemas/rest-core.ts` | `orgPolicySchema` gains nothing (agent policy stays C's); new `unattendedPolicySchema` lives in `fleet/policy.ts`; `userSchema` += `deviceGroupIds?: uuid[]` |
| `audit/actions-p4.ts` | the §3.8 / §6.3 / §9 / §10 actions in `AUDIT_ACTIONS` with chain schemas; wire branches in `deskEventDataSchema`/`assistEventDataSchema`/a new `deviceEventDataSchema` |

`LIMITS` additions: `deviceBootstrapTtlSec: 300`, `deviceDisabledRetrySec: 3600`, `deviceQueueDrainMax: 100`, `wakeConfirmSec: 120`, `tamperSilentGraceSec: 900`, `enrollConfigMaxBytes: 16384`, `deviceActionTtlDays: 7`, `deviceActionOutputMaxBytes: 1048576`, `maxUnattendedMinutesCap: 1440`, `deviceTagsMax: 32`, `deviceGroupsPerOrgMax: 500`, `fleetPageMax: 200`.

### 13.1a Key wire objects (binding field tables)

**`Device`** (REST, `fleet/device.ts`; the list/detail object the fleet console renders):

| Field | Type | Rule |
|---|---|---|
| `id` | uuid | device id |
| `name` | string (<=80) | machine name, sanitised |
| `platform` | `DevicePlatform` | `windows` in Phase D |
| `status` | `DeviceStatus` | `enrolled` \| `disabled` \| `superseded` \| `retired` |
| `online` | boolean | folded from presence (`ia:dev:<id>`), not a column |
| `keyId` | string (16 hex) | `kidOf(public_key)`; the public key itself is never in the wire object |
| `osVersion` / `arch` / `agentVersion` / `serviceVersion` | string \| null | reported facts, updated each `device.hello` |
| `groupId` | uuid \| null | the device's group (null = org default policy) |
| `tags` | string[] (<= `deviceTagsMax`) | each sanitised, <= 40 |
| `capabilities` | `ServiceCapabilities` | §below |
| `amt` | `AmtInventory` \| null | `null` when `present` is false or never reported |
| `tamperState` | `TamperState` | `ok` \| `alerted` \| `suspected` |
| `lanSegmentHash` | hex \| null | `lan_segment.subnetHash`; raw CIDR/MAC never exposed |
| `notifyEmail` | string \| null | consent-receipt / tamper address (also inheritable from group) |
| `lastSeenAt` / `enrolledAt` | ISO \| null | |
| `lastIp` | string \| null | operational; in residency scope, org_admin/auditor only |

**`ServiceCapabilities`** (`serviceCapabilitiesSchema`, strict; superset of C `AgentCapabilities`):

| Field | Rule |
|---|---|
| `monitors` | int `1..16` |
| `elevation` | `'admin'` always (the service is `LocalSystem`); privileged mode is level, not integrity (§5.2) |
| `features` | unique values of `SERVICE_FEATURES` (C `AGENT_FEATURES` + `secure_desktop`, `service_input`, `input_lock`, `privacy_screen`, `waker`, `amt`, `sas`); the console greys a control whose feature is absent |
| `encoders` / `hwEncoder` / `interpreters` | as C §3.1 |
| `serviceVersion` | the installed service version (may differ from the desktop worker's `agentVersion` across an upgrade) |

**`AmtInventory`** (`amtInventorySchema`): `{ present: boolean, provisioned: boolean, version?: string (<=32), host?: string (<=255), tls: boolean, powerState?: int }` — reported at enrollment and heartbeat; the fleet view shows "Cold power on: available" only when `present && provisioned`.

**`LanSegment`** (`lanSegmentSchema`): `{ subnetHash: hex64, gatewayMacHash: hex64, dhcpDomain?: string (<=255) }` — hashes computed on the device so raw addresses never travel; devices sharing `subnetHash` form a waker segment (§8.2).

**`DeviceAction`** (REST + `device.action` push): `{ id: uuid, deviceId: uuid, kind: DeviceActionKind, payload: <per-kind, §9>, state: DeviceActionState, reason: string \| null, result: { exit?: int, ranAs?: 'user'\|'admin', pages?: int, path?: string, error?: string } \| null, createdBy: { id, name }, createdAt, dispatchedAt \| null, completedAt \| null, expiresAt }`. `state` runs `queued → dispatched → running → done\|failed`, or `cancelled`/`expired`; the device reports transitions via `device.action_result` (§9.7), chained as `device.action_completed`.

### 13.2 Database (`packages/db`, migration `0007_phase_d`)

| Change | Detail |
|---|---|
| pgEnum `device_status` | add `superseded`, `retired` (ALTER TYPE ADD VALUE) |
| pgEnum `device_platform` | new (`windows`, `macos`, `linux`) |
| pgEnum `unattended_mode` | new (`allow`, `approval_only`, `deny`) |
| pgEnum `device_action_kind` | new (`playbook_run`, `file_push`, `print`, `message`) |
| pgEnum `device_action_state` | new (`queued`, `dispatched`, `running`, `done`, `failed`, `cancelled`, `expired`) |
| pgEnum `wake_method` | new (`wol`, `amt`, `auto`) |
| pgEnum `wake_state` | new (`pending`, `dispatched`, `woke`, `failed`) |
| pgEnum `tamper_state` | new (`ok`, `alerted`, `suspected`) |
| pgEnum `session_end_reason` | add `policy_timeout` |
| `device` (extend A's placeholder) | add `region` region not null, `platform` device_platform not null default `windows`, `key_id` text, `os_version` text, `agent_version` text, `service_version` text, `arch` text, `hw_fingerprint` char(64), `last_ip` text, `group_id` uuid null fk device_group, `unattended_policy` jsonb null (override), `lan_segment` jsonb null, `mac_enc` text null, `mac_hash` char(64) null, `amt` jsonb null, `tamper_state` tamper_state not null default `ok`, `notify_email` text null, `enrolled_at` timestamptz; `public_key` and `enrolled_by_token_id` already exist; index `(org_id, status)`, `(org_id, group_id)`, `(lan_segment->>subnetHash)` via a generated column or expression index |
| `device_group` | new: `id` pk, `org_id` fk org index, `name` text (1..80, sanitised), `description` text null, `default_policy` jsonb not null, `default_tags` text[] not null default `{}`, `notify_email` text null, `created_by` fk user, `created_at`/`updated_at`, unique `(org_id, name)` |
| `device_action` | new (§9.2) |
| `wake_attempt` | new: `id` pk, `org_id` fk index, `device_id` fk, `created_by` fk user, `method` wake_method, `via` text null (deviceId of the waker / `amt`), `state` wake_state, `cause` text null, `created_at`, `confirmed_at` null |
| `session.device_id` | uuid null fk device, index; set for P4 sessions |
| `session.unattended_policy` | jsonb null (snapshot that allowed an unattended start) |
| `user.device_group_ids` | uuid[] null (group scoping, §7.1) |
| `org.waker_mesh_enabled` | boolean not null default true |
| `org.unattended_policy` | jsonb not null default `DEFAULT_UNATTENDED_POLICY` |

Append-only triggers and the A §4.2 lock order are untouched; every new audit action goes through `insertAuditEntry`. Device rows are mutable (last-seen, versions, tamper state); the chain records every privileged event, not the row mutations.

### 13.3 Audit actions (`actions-p4.ts`, strict chain schemas)

| Action | Actor | Written on | Chain `data` |
|---|---|---|---|
| `device.enrolled` | system | `POST /devices/enroll` | `{ deviceId, tokenId, keyId, platform, group }` |
| `device.superseded` | system | re-enroll (§3.6a) | `{ fromDeviceId, toDeviceId }` |
| `device.key_rotated` | system | `device.rotate` | `{ fromKeyId, toKeyId }` |
| `device.updated` | user | PATCH | `{ deviceId, fields }` |
| `device.disabled` / `device.enabled` / `device.retired` | user | REST | `{ deviceId }` |
| `device.deregistered` | device | uninstall | `{ deviceId }` (actor device, signed deregister) |
| `session.unattended_started` | desk | server, at `active` for an unattended session | `{ approvedBy: 'policy' \| 'local_user', policySnapshot }` |
| `capture.secure_desktop` | desk | `desk.event` | `{ durationMs }` |
| `input.lock_changed` | desk | `desk.event` | `{ locked: boolean }` |
| `privacy_screen_changed` | desk | `desk.event` | `{ on: boolean }` |
| `device.wake_requested` | user | `POST /wake` | `{ deviceId, method }` |
| `device.wake_dispatched` | device/system | the waker emitted / AMT sent | `{ wakeId, viaDeviceId \| 'amt' }` |
| `device.woke` | system | device reconnected in window | `{ wakeId, method, via, elapsedMs }` |
| `device.amt_poweron` / `device.amt_sol_opened` | user | AMT path | `{ wakeId, viaDeviceId }` |
| `device.action_queued` / `_dispatched` / `_cancelled` | user | REST / dispatch | `{ actionId, kind }` |
| `device.action_completed` | desk | `device.action_result` | `{ actionId, kind, state, exit?, ranAs? }` |
| `tamper.alert` | device | server, from `device.tamper` | `{ cause, at, detail }` |
| `tamper.acknowledged` | user | REST | `{ deviceId, cause }` |
| `device_group.created` / `_updated` / `_deleted` | user | REST | `{ groupId, fields? }` |
| `org.policy_updated` | user | PATCH unattended policy | `{ fields: ['unattended'] }` (B naming reused) |
| `device.enroll_config_issued` | user | `GET /enroll-config` | `{ tokenId, groupId }` |

A new `device.event` D→S message (actor device, signed outbox like C §3.8) carries `capture.secure_desktop`, `input.lock_changed`, `privacy_screen_changed`, `device.action_completed`, `device.tamper`, `device.deregistered`; the attestation-outbox rule of B §3.7 applies (never dropped, flushed before the device socket closes). `POST /sessions/:id/events` gains the user-side counterparts where a console reports (`elevation.requested` for privileged mode is reused from C).

### 13.4 Console (`apps/web`)

| Page / component | Behaviour |
|---|---|
| `/app/fleet` | the **fleet console**: a filterable/sortable device table (name, group, tags, online dot, last seen, OS/version, tamper badge, "Cold power on: available/not available", unattended mode); bulk tag/group/policy actions (org_admin); a group sidebar with per-group policy editor |
| `DeviceRow` / `DeviceDetail` | status, capabilities, effective policy, AMT inventory, recent sessions, offline-queue; actions: **Connect** (→ `POST /devices/:id/sessions`), **Wake** (method picker, live state), **Run action** (playbook/file/print/message), **Disable/Retire/Rotate key** (org_admin) |
| `UnattendedPolicyEditor` | the §6.1 fields with safe defaults, an "allowed hours" builder, and clear warnings on `allow` + `allowSecureDesktop`/`allowPrivileged` ("this group can be entered with nobody present and the technician can see Windows security screens"); audited on save |
| `AgentConsole` (P4) | the C §13.4 console plus: an **Unattended** banner ("No one is at this device — session is policy-authorised and recorded"), **Input lock** / **Privacy screen** toggles (greyed unless `elevated` + policy), a **Send Ctrl+Alt+Del** button, a **Secure desktop** indicator (and a "hidden by policy" state), and the recording badge forced-on when `recordingRequired` |
| `WakePanel` | method (`auto`/`wol`/`amt`), the resolved `via` (which waker / AMT), live `pending → dispatched → woke/failed` with honest failure causes; a read-only **SOL console** pane when AMT SOL is opened |
| `DeviceGroupAdmin` | group CRUD, default policy, default tags, notify email, technician group assignment (`user.device_group_ids`) |
| Tokens page | **Download MSI (enrollment)** per enrollment token + group selector (calls `GET /devices/enroll-config` and serves the branded MSI/transform), plus GPO/Intune copy-paste snippets |
| Residency page | fleet counts, wake attempts, unattended sessions, AMT-over-plain-HTTP flags |

The console reads the session level from `consent.changed` (C rule); "privileged mode" sets/reads `elevated`. The SAS confirmation gate (C §1.3 step 7) applies to P4 sessions exactly as P3, including after a desktop-switch rebuild (§5.3).

---

## 14. Security

| Asset / surface | Threat | Mitigation |
|---|---|---|
| Device identity key | a stolen disk/image impersonates the device | DPAPI machine scope + an ACL'd HKLM entropy blob binds the sealed key to the machine (§3.3); a copied disk cannot unseal on another host; a re-image with a wiped key needs a fresh enrollment token and supersedes the old row visibly (§3.6a); the key never leaves the device, never logged |
| Enrollment token | a leaked enrollment token enrolls a rogue device | the token is single-mint (`used` on first enrollment, W30), short-lived (7 d default), `p4_installed`+`enrollment` only, bound to its org/region; enrollment requires a device-key possession proof (`deviceKeyProof`); every enrollment is audited; an org_admin sees the device appear and can disable it |
| Device auth replay | a captured `device.hello` is replayed | a fresh per-socket `serverChallenge` is signed each time (§3.4); the bootstrap credential is single-use (`consume`); a disabled/retired device is refused `4412` |
| Unattended abuse | a technician silently watches a machine nobody is at | the pill/tray/recording dot are mandatory and injection-proof (C §3.5, re-imposed by the service); every unattended start writes `session.unattended_started` with the policy snapshot; `recordingRequired` default-on; a consent receipt is produced and emailed to the device notify address; `mode` defaults to `approval_only` until an admin opts a group into `allow`; `requireLocalApprovalWhenPresent` stops taking over an in-use machine |
| Privileged mode | capture of the secure desktop / input lock / privacy screen without cause | each is `elevated`-gated and per-capability policy-gated (default false), requested with a typed reason, chained (`elevation.requested`/`.granted`, `capture.secure_desktop`, `input.lock_changed`, `privacy_screen_changed`); input lock fails open to the user (Ctrl+Alt+Del always escapes) |
| Local attack surface | a local port/pipe another process abuses; a same-user process writes a file the service runs | the service opens no listening socket; the service↔worker pipe is `FIRST_PIPE_INSTANCE | REJECT_REMOTE_CLIENTS` with a SYSTEM+worker-SID DACL and pid/image verification (§4.2); the worker credential is single-use and session-bound; playbook execution follows C §8 (stdin for PowerShell, admin-only HI-labelled dir for cmd, hash re-check before resume); config/key/manifest are SYSTEM+Administrators, high mandatory label (§3.3, §10.4) |
| MAC/address leakage | the fleet DB leaks device MACs/IPs | MACs are stored encrypted to the org waker key and only de-dup-hashed (§8.2c); LAN segments are hashed, not raw CIDRs; `last_ip` is operational and in the residency scope; waker pushes carry the encrypted MAC only (W33) |
| AMT credentials | powerful out-of-band creds stored on a device | AMT admin creds live only in the credential vault (§8.3c, §12-vault), injected for one command to the AMT proxy then wiped, never on a device row or a log; plain-HTTP AMT is flagged in residency |
| Waker mesh misuse | a compromised device wakes/attacks peers | a waker's only power is emitting a magic packet (a broadcast of a MAC it decrypts for one target); it gains no session authority; `wake.send` is server-driven and chained (`device.wake_dispatched`); the mesh is opt-in per org/device |
| Tamper / silent kill | an attacker disables the agent to hide activity | the watchdog (service + scheduled task) restarts/alerts; local tamper events are device-key-signed, backfilled and chained (`tamper.alert`); a silent-past-grace device is flagged `tamper_suspected`; integrity self-check refuses to spawn a modified worker; the honest claim is visibility, not prevention (P7, §10) |
| Secure channel / MITM | the signaling server rewrites fingerprints | unchanged from C §1.3 (commit round, SAS, fingerprint binding, per-key-generation control gate); a desktop-switch rebuild re-confirms the SAS |
| Data residency | fleet/wake/AMT data leaving the region | device rows, groups, actions, wake attempts and audit stay in the org's region (A T1); the device connects to the region origin; the waker mesh and AMT act within the device's own LAN; the residency report lists device counts and any plain-HTTP AMT |

The pino `REDACT_PATHS` gains `'*.boot'`, `'*.privkey'`, `'*.macEnc'`, `'*.deviceKeyProof'`, `'*.secret'`, `'*.vaultToken'`, `'*.serverChallenge'`; `device.key`, `config.json`, the AMT creds and the waker key are never logged. The service's `tracing` redaction mirrors C §6.

---

## 15. Tests and gates

### 15.1 Shared (vitest)

`test/fleet-policy.test.ts` (`resolveUnattendedPolicy` override/group/org, `isWithinPolicyWindow` across the tz boundary, defaults safe), `test/fleet-schemas.test.ts` (device/group/action/wake/tamper schemas, `deviceEnrollRequest/Reply`, the device signal messages, `serviceCapabilities`, `amtInventory`, `lanSegment`), `test/fleet-actions.test.ts` (per-kind payloads, the `playbook_run` reuse of C's arg validation), extended `test/signal-schemas.test.ts` (device.hello/ok/heartbeat/session_open/action/tamper/woke/wake.send unions), `test/audit-p4.test.ts` (every §13.3 action wire-vs-chain). The agent name/fixture parity check (C §15.1) is extended with `fleet/*` fixtures.

### 15.2 Service / worker (Rust, `cargo test`)

Pure, portable: identity key gen + sign/verify round-trip, the device-auth challenge signing, `resolveUnattendedPolicy` parity with the TS fixture, the enrollment client state machine, the offline-queue drain ordering, the magic-packet builder (bytes against a vector), segment math, MAC encrypt/decrypt round-trip, the AMT WS-Man request builder (XML against a vector), the handoff-blob codec, the DPAPI seal/unseal round-trip behind a trait mock. `#[cfg(windows)]`: the DACL/pipe-name derivation for the service↔worker pipe (reusing the C §7.2 pid/image checks against a fake peer), desktop-selection logic against a mock `WTS`/desktop table, the watchdog detect-and-restart decision table, the DPAPI machine-scope seal on the real host (gated, skipped on a non-Windows runner). The `ia-desktop` worker reuses the C loopback test; a new loopback test drives the §4.2 handoff (service writes a blob, worker reads it and reaches `active`). No test calls `CreateProcessAsUser`, `SendSAS`, `BlockInput`, a real AMT host, or `ShellExecuteExW` (no privileged side effects in CI); those paths are exercised behind traits with mocks and documented as manual-check steps in `docs/release.md`.

### 15.3 API / web (vitest, Playwright)

api: `test/enroll.test.ts` (token verify, single-mint race → one device, `deviceKeyProof` check, bootstrap consume, region binding), `test/device-signal.test.ts` (challenge/hello/auth, bad signature → 4412, disabled → 4412, heartbeat presence, queued drain on hello), `test/devices.test.ts` (fleet RBAC incl. own-group scoping and cross-org 404, PATCH, disable/enable/retire/rotate, session open with every policy outcome, wake request, action queue CRUD, residency counts), `test/wake.test.ts` (waker election in a segment, `no_waker`/`no_confirm`/`amt_unreachable` honest states, MAC never stored plaintext, wake audit pair), `test/offline-queue.test.ts` (queue-then-deliver on reconnect, expiry sweep, per-kind validation, result chaining), `test/tamper.test.ts` (backfilled `device.tamper` → `tamper.alert`, silent-past-grace → `suspected`, acknowledge). web: `/app/fleet`, `DeviceDetail`, `UnattendedPolicyEditor` (dangerous-default warnings), `WakePanel`, `AgentConsole` P4 additions (unattended banner, input-lock/privacy toggles gated on `elevated`+policy, SAS button), tokens-page MSI download. `smoke:p4` (`scripts/smoke-p4.mjs`, Node, no browser): a Node ws client simulates a device through enrollment (`POST /devices/enroll`), `device.hello` with a signed challenge, `POST /devices/:id/sessions { unattended: true }` reaching `active` with `session.unattended_started` chained, a queued `device.action` delivered on reconnect and its result chained, a `POST /wake` whose waker peer (a second simulated device) emits and confirms, and a `device.tamper` producing `tamper.alert`.

### 15.4 Gates and definition of done

| Stream | Must pass |
|---|---|
| shared/db/api | `pnpm --filter @indiansassist/shared typecheck test`, `--filter @indiansassist/db typecheck test` (migration `0007_phase_d` applies on PGlite; new enums, `device`/`device_group`/`device_action`/`wake_attempt` round-trip), `--filter @indiansassist/api typecheck test`; `pnpm smoke` 26/26, `smoke:p2`, `smoke:recorder` 12/12 + P3, `smoke:p3`, and new `smoke:p4` green |
| service | `cargo build`, `cargo test` (incl. the handoff loopback) and `cargo clippy -D warnings` green; `node scripts/license-check.mjs` passes with the new crates and WiX/OpenBao entries; **CI:** `cargo build --release --locked` both msvc targets, the import-table + size gates per exe, Authenticode on all three exes and the MSI, `wix build` produces a signed MSI, the `WinVerifyTrust` self-check runs |
| web | `pnpm --filter @indiansassist/web typecheck test build`; the P4 Playwright specs green |
| packaging/integration | the MSI installs/uninstalls cleanly in a Windows sandbox (manual-check in `docs/release.md`), `docs/LICENSE-REGISTER.md` lists every §11.2 entry (WiX as a non-shipped build tool, OpenBao as a separate service), `infra/.env.example` documents any new api env, `pnpm validate:infra` green |

**Definition of done for Phase D:** a signed MSI enrolls a Windows device that mints a device identity and discards the enrollment token; the device appears online in the fleet console; an org_admin sets a group's unattended policy; a technician opens an **unattended** session (policy-authorised, recorded, pill visible, consent receipt produced) and, with privileged mode, captures the secure desktop, locks local input and sends Ctrl+Alt+Del; a sleeping device is woken over the LAN waker mesh and an AMT-capable device is powered on from off; an offline device runs a queued playbook and file push on next check-in; stopping the service raises a `tamper.alert` visible in the fleet view; all gates above are green and the §16 PRD-deviation table is applied to `PRD.md`.

---

## 16. Open questions resolved and PRD deviations

| # | PRD / task text | Phase D position | Why |
|---|---|---|---|
| W28 | PRD 3/5 "installed as a system service ... boot time and pre-login access" | a `LocalSystem` service in session 0 **plus** a per-session `ia-desktop` worker launched onto the active (or secure/logon) desktop, over a hardened pipe (§1.4, §4) | a session-0 service cannot capture or inject on a user/secure desktop; the worker must run in the target session; the worker reuses the Phase C agent unchanged |
| W29 | PRD 6 token flow applied to P4 | after enrollment the **device identity** is the credential for every session (attended or unattended); no per-session `one_time`/`timed` P4 token is minted | the device is always-connected and cryptographically identified; a fresh token per session would recreate the attended flow for a machine that is already trusted |
| W30 | PRD 6 "enrollment tokens that mint a long-lived device identity, then are discarded" | the enrollment token is **single-mint** (`used` on first `POST /devices/enroll`) and shredded from `enroll.iaconfig`; the device key pair is the long-lived identity (§3) | a token that could enrol twice would be a standing credential; minting one identity then discarding it is exactly the PRD's shape |
| W31 | how the worker joins the already-open session without a new code path | the worker presents a short-lived **worker credential** the service obtains and treats server-side exactly like the C §7.2 hand-over (register as Desk onto the open session) | reuses the Phase C resume/hand-over machinery byte-for-byte; keeps `ia-agent` unchanged |
| W32 | PRD 3 P3→P4 "elevation" vs a `LocalSystem` service | P4 "privileged mode" raises `session.consent_level` to `elevated` **in place**, with no UAC relaunch (the service is already `LocalSystem`); C §7 hand-over is not used in P4 | there is no higher integrity to hand over to; the elevation audit and policy gate still apply |
| W33 | PRD 12.5 WoL needs the target MAC | MACs are stored **encrypted to the org waker key** (+ a de-dup hash); the chosen waker decrypts one target MAC to build the packet; no plaintext MAC in a row or log | a fleet DB of plaintext MACs/IPs is a lateral-movement map; the waker needs the MAC only at send time |
| W34 | PRD 3 "Remote power on ... optional and hardware gated" vs decision 15.3 "ships in v1" | AMT power-on + SOL **ship in v1**, gated by `amt.present && amt.provisioned` and surfaced as "available/not available"; deeper AMT provisioning is deferred | decision 15.3 overrides the earlier "optional" wording; the gate keeps the UI honest (P8) |
| W35 | PRD 7 "require a one-time local approval window during enrollment" | the one-time local approval is modelled as the policy's `approval_only` mode and `requireLocalApprovalWhenPresent`; a session approved by a sitting user chains `approvedBy: 'local_user'` | a per-session policy decision is more precise than a single enrollment-time toggle and still satisfies the PRD |
| W36 | PRD 3/5 macOS `launchd` + Linux `systemd` "Package 4" | **deferred to Phase E**; the `ia-platform` traits leave the seam; Phase D binds Windows only | Windows is the first platform per PRD section 5 and the existing Phase C precedent |
| W37 | PRD 8 credential vault "OpenBao or Vault" | `ia-vault` is an AppRole HTTP client to a self-hosted OpenBao/Vault, injecting secrets into a child's environment (AMT creds, privileged-playbook secrets), never to the console | credential injection not exposure (PRD 7); the vault runs as a separate service, same licence posture as Garage/Keycloak |
| W38 | PRD 4 "Remote printing: Yes" (P4) | a `print` offline/online action and a signed `__ia_print` built-in playbook print a fetched document to the device's default/named printer | printing reuses the action/playbook machinery and the object store; no new transport |
| W39 | task: WiX for the MSI | the MSI is built with **WiX Toolset v5 installed as the .NET global tool** (`dotnet tool install --global wix`); WiX (MS-RL) is a non-shipped build tool and is recorded in the licence register | WiX is not installed on the build host but installs as a .NET tool; MS-RL is fine for an unmodified build tool we do not redistribute |

### 16.1 PRD and spec amendments to apply

- PRD 3 Package 4: AMT is a v1 feature with a hardware gate (already decision 15.3); the service shape is §1.4; the C §7.4/W9 deferrals (secure-desktop/lock-screen capture, service-grade input, input lock, privacy screen) are delivered here (§5).
- PRD 11 `POST /devices/:id/wake` → §8.1; `POST /devices/:id/script` → `POST /devices/:id/actions { kind: 'playbook_run' }` and the online dispatch / offline queue (§9), with `POST /devices/:id/sessions` for live entry (W29).
- PRD 6 enrollment: made concrete in §3; the enrollment token is single-mint and discarded (W30); the device identity is the standing credential (W29).
- A §2.1 `p4_installed` / `enrollment`: `desk.hello` still answers `join_unsupported`; the device uses `device.*` (§3.4); A §3.2 `enrollment` tokens become functional (enroll, not join).
- A device table (A §4.2 placeholder) is extended by migration `0007_phase_d` (§13.2); A §6.3 residency report gains fleet counts; A §2.3 permission matrix gains the device/fleet rows (§7.1); A §7.2 Origin-less rule generalised to a `deviceOnly` socket that may send `device.hello`; A §7 close codes gain **`4412`**; `session_end_reason` gains `policy_timeout`.
- C §5.1 `os.input_lock` / `os.privacy_screen` become supported in P4 (§5.4); C §4.1 secure-desktop "delivers nothing" is lifted for P4 (§5.1); C §7 hand-over elevation is replaced in P4 by in-place privileged mode (W32); C §3.5 indicator/self-defence are re-imposed by the service for unattended and secure-desktop sessions.
- A.2: the server recorder is assigned to `p4_installed` sessions exactly as `p3_portable` (the worker answers the recorder offer, C §9); `recordingRequired` policy forces at least `server` mode.
- `apps/api`: new `src/signal/device.ts`, `src/fleet/*`; `src/signal/hub.ts` `deskOnly` generalised to also register device presences; new env `AGENT_MSI_DIST_DIR` (branded MSI artifacts), `VAULT_ADDR`/`VAULT_ROLE_ID`/`VAULT_SECRET_ID` (optional, credential vault), `WAKE_CONFIRM_SEC`.
- `docs/LICENSE-REGISTER.md`: add `windows-service`, `quick-xml` (if used), **WiX Toolset (MS-RL, build tool, not shipped)**, **OpenBao (MPL-2.0, separate service)**; `scripts/license-check.mjs` enforces it over `cargo metadata` and the packaging tool list.
- `docs/PLAN.md` Phase D line and `docs/release.md`: add the MSI/GPO/Intune build and signing steps and the manual install/uninstall and privileged-path checks.

*End of Phase D contracts. Amend this file first, then the code.*
