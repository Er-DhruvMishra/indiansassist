# Phase D technical contracts (binding): Package 4, installed agent with unattended access, wake and power-on, fleet management, mass deployment

Status: binding for Phase D. Revision 2, 1 Nov 2026 (revised after the contract review: every change this document makes to existing shared code, the database or the A/B/C contracts is indexed in §16.2 as file, symbol, old, new). Implements PRD section 3 "Package 4", section 4 (feature matrix P4 rows), section 5 (Windows unattended; macOS/Linux unattended rows are scoped to Phase E here), section 6 (enrollment tokens that mint a long-lived device identity then are discarded), section 7 (device identity, consent and unattended policy, credential vault), section 10 (device table), section 11 (`POST /devices/:id/wake`, `POST /devices/:id/script`), section 12 items 5 (LAN waker mesh), 12 (offline action queue) and 13 (self-healing, tamper-alerting agent), section 13 (non-functional), and decision 15.3 (AMT power-on ships in v1, hardware gated). It also delivers the capabilities PRD 15.7 / decision 7(d) moved out of Phase C into "the Phase D service": secure-desktop and lock-screen capture, service-grade input that survives UAC dialogs, input lock and privacy screen.

**Phase A (`docs/specs/phase-a-contracts.md`, "A"), Phase A.2 (`docs/specs/phase-a2-recorder.md`, "A.2"), Phase B (`docs/specs/phase-b-contracts.md`, "B") and Phase C (`docs/specs/phase-c-contracts.md`, "C") stay binding**; this document only adds to them and lists every amendment in section 16. Four streams build from it in parallel without talking: **service** (`agent/`, Rust, new crates), **shared/db/api** (`packages/shared`, `packages/db`, `apps/api`), **web/fleet console** (`apps/web`), **packaging** (`packaging/`, scripts, infra, CI, licence register). If something here is wrong, amend this file first, then the code.

Vocabulary (inverted): **Desk** = the employee's computer being helped (now runs the installed service). **Assist** = the technician console (`apps/web`). "P4" = Package 4, tier `p4_installed`. "Service" = the installed Windows service. "Agent" = the Phase C portable Rust client (still the per-session worker; P4 reuses it as the desktop worker, §4). "Device" = an enrolled P4 machine with a cryptographic identity.

Conventions: everything in the A, B and C conventions tables applies (camelCase wire keys, `ts` = integer ms, ISO 8601 elsewhere, lower snake_case enums, base64url without padding, lower-case hex, `tier` never `package`, `monitorId`/normalised coordinates/`AgentConsentLevel`/encrypted-channel rules of C §1). New ones:

| Convention | Rule |
|---|---|
| `deviceId` | the `device.id` UUID; printed to the user and in audit as `device:<first 8 chars>` for a `device` actor |
| `device` actor | `ACTOR_TYPES` gains `device` (§16.2): `actor_type = 'device'`, `actor_id` = `device.id`, display `device:<first 8 chars>`; used only for events the device itself attests (signed), never for events the server derives (those are `system`) |
| Device identity key | a per-device Ed25519 key pair generated **on the device** at enrollment; the private key never leaves the device (DPAPI-at-rest, §3.3); the public key is `device.public_key` (base64url 32 bytes), and `kid` of it (C/A `kidOf`, 16 hex) is `device.key_id` |
| Device sealing key | a second per-device key pair, **X25519**, generated with the identity key and sealed the same way (§3.3); its public half is `device.kex_public_key` (base64url 32 bytes). The server uses it to seal one-use secrets to exactly one device (vault secrets §9.8, AMT credentials §8.4c, a wake target's MAC §8.2c) with the C §1 primitives: `sealed = { epk, nonce, ct }` where `key = HKDF-SHA256(ikm = X25519(eph, kex), salt = nonce, info = utf8("ia-seal-v1") ‖ purpose)`, `ct = XChaCha20-Poly1305(key, nonce, plaintext, aad = utf8(deviceId))`; shared `fleet/seal.ts` `sealToDevice`/`openSealed`, Rust `ia_core::seal` |
| Device signatures | every Ed25519 signature a device makes is over `deviceSigningInput(domain, fields)` (shared `fleet/signing.ts`, Rust `ia_core::devsig`): the bytes `utf8(domain)` then, for each field in the order the table gives, a 4-byte big-endian length followed by the field bytes. Field encodings: UUIDs as their lower-case 36-character text in UTF-8; base64url values **decoded to raw bytes**; integers as decimal ASCII; structured payloads as `canonicalJsonBytes(value)` (shared `canonical.ts`). Pure Ed25519 (RFC 8032), no prehash. The domains and fields are bound in §3.8; vectors live in `packages/shared/test/fixtures/fleet/signatures.json` and both languages must reproduce them |
| Section references | "A §7.3" = Phase A; "B §5" = Phase B; "A.2 §6" = recorder; "C §7" = Phase C; "§4" = this document |
| Package and module names | `agent/` gains crates `ia-service` (the Windows service), `ia-session0` (session/desktop bridge), `ia-waker` (LAN waker + AMT), `ia-vault` (credential-injection client); `@indiansassist/shared` gains `src/fleet/*`; `apps/api` gains `src/fleet/*` and `src/signal/device.ts`; `packaging/` holds the MSI/GPO/Intune artifacts |
| Ownership of names | every wire message, enum, limit and schema is defined once in `packages/shared` and mirrored by the Rust (`serde`) types; §13.1 is the index; cross-language fixtures extend `packages/shared/test/fixtures/agent/*.json` and gain `packages/shared/test/fixtures/fleet/*.json` |
| Libraries added | Rust crates and tools are listed with licences in §11.2 and added to `docs/LICENSE-REGISTER.md` in the same change; the web adds nothing new; the api adds **nodemailer** (MIT-0) for the consent-receipt mailer (§6.4); packaging adds **WiX Toolset** (installed as a .NET tool, §12.2) |

---

## 1. Scope, principles and architecture decisions

### 1.1 In scope (Phase D, Windows)

| # | Deliverable | PRD |
|---|---|---|
| 1 | The Windows **service** install, running as `LocalSystem`, surviving logoff and reboot, available before any user logs in | 3, 5 |
| 2 | **Enrollment**: an `enrollment` token mints long-lived **device identities** (device key pairs + `device` rows), up to the token's `maxDevices` so one GPO/Intune rollout enrolls a whole fleet; each device discards the token the moment it holds its own identity and thereafter authenticates by signature, never by the token (§3.1, W30) | 6, 7, 10 |
| 3 | **Unattended access**: an Assist opens a session to an enrolled device with nobody at the Desk, **policy-gated and logged**, with the visible indicator still mandatory and a local approval whenever the policy asks for one (W35) | 3, 7 |
| 4 | Service-grade capabilities a user/admin process could not provide (C §7.4, W9): **secure-desktop and lock-screen capture**, **service-grade input** that survives UAC dialogs and the secure desktop, **input lock**, **privacy screen** | 3, 5, 7, 12.3 |
| 5 | **Wake on LAN** (`POST /devices/:id/wake`) via a **LAN waker mesh**: any online P4 device wakes its sleeping subnet peers with a magic packet | 3, 11, 12.5 |
| 6 | **Remote power-on from off** via **Intel AMT / vPro**, self-hosted, hardware gated and surfaced in the fleet view (decision 15.3, v1) | 3, 11, 15.3 |
| 7 | **Fleet management**: devices, groups, tags, and **policy per group**; a fleet console page | 3, 10 |
| 8 | **Mass deployment**: a signed **MSI** (built with WiX), GPO and Intune guidance, branded per org | 3, 4, 5 |
| 9 | **Offline action queue**: file pushes and playbooks queued for an offline device, executed and logged at next check-in | 12.12 |
| 10 | **Self-healing, tamper-alerting agent**: the service notices if it is stopped, disabled or modified and raises an audited alert | 12.13 |
| 11 | **Remote printing** of a document to a device's default printer through a playbook-style action (PRD 4 P4 "Remote printing: Yes") | 4 |
| 12 | **Credential vault** injection (OpenBao / Vault) for privileged P4 workflows (credential injection, never exposure); moved forward from PRD 14 Phase E because AMT power-on (v1, decision 15.3) needs it (W40) | 7, 8, 14 |

### 1.2 Out of scope (deferred)

| Item | Phase | Note |
|---|---|---|
| macOS `launchd` daemon and Linux `systemd` unit (unattended on those OSes) | E | the `ia-platform` traits (C §11.1) are extended with `ServiceHost`, `DesktopBridge`, `Waker`, `Amt`, `SecretInjector` so the ports are mechanical; this document binds **Windows** |
| Android unattended / persistent host | E | the Android host stays attended (C §12); "Keep installed" (C §10 D5) is still only a user-level copy |
| iOS anything | E | unchanged |
| Pre-boot full-disk or BIOS management beyond AMT power-on (e.g. PXE re-image, BIOS settings push) | later | AMT is power-on, SOL console and boot-device redirection only (§8.4); deeper AMT/MEBx provisioning is a follow-up |
| Automatic patch management / software distribution beyond the offline action queue running playbooks | later | playbooks are the mechanism; a package manager is not built |
| Billing / seat metering for P4 devices | E | PRD decision 15.2 is per Assist seat; device count is reported in the fleet view and residency report but never metered here |

### 1.3 Principles

| # | Principle | Consequence |
|---|---|---|
| P1 | **Same session, installed Desk.** A P4 session is a C-style `p4_installed` session whose Desk is the installed service's desktop worker, a native WebRTC peer. Signaling, `ia.sec`, the recorder, chat, files, annotations, playbooks, elevation-less admin (the service is already `LocalSystem`), audit and recordings are reused unchanged unless §16 says otherwise. "Reused" is made true in code by one shared predicate: `isNativeTier(tier)` (`p3_portable` \| `p4_installed`, §13.1); every branch in shared, api, web and recorder that today tests `tier === 'p3_portable'` to mean "native agent session" moves to it (the full list is §16.2). Tests that mean "the portable P3 download/join flow" (download stub, `/join`, `iaconfig` sidecar, desk-code retirement) stay `p3_portable`-only. | The console, api hub and recorder need additions, never rewrites |
| P2 | **Identity, not a bearer.** After enrollment the device never presents the enrollment token again. It authenticates to `/signal/device` with a signed challenge over its device key (§3.4). An enrollment token works only inside a region-signed `enroll.iaconfig`, enrolls at most `maxDevices` devices, can be revoked, and grants nothing to devices already enrolled (§2.1, §3.2); a stolen disk is useless without the DPAPI-sealed key and the machine it was sealed on (§3.3). | §3, §14 |
| P3 | **Consent is visible even when unattended.** PRD 7 forbids silent watching. An unattended P4 session shows the same always-on-top pill, tray state and recording dot as C §3.5 on whatever desktop is active (including the secure desktop and the logon screen, §5.3), plus a per-session **consent receipt** (PRD 12.14) and, when the policy requires it, a local approval the sitting user (if any) must grant. The indicator cannot be switched off, is immune to injected input (C §3.5 self-defence, re-imposed by the service) and is drawn above the privacy-screen overlay (§5.4); a user who sits down mid-session is told and can end it (§6.2). Receipts reach an absent user later (§6.4). | §5, §6 |
| P4 | **Unattended is a policy, logged per use.** Whether a device may be entered with nobody present, and under what conditions (hours, approval, recording), is the device's **unattended policy**, set per group and overridable per device (§6). Every unattended entry writes `session.unattended_started` with the policy snapshot and the technician's typed reason; a device whose policy forbids it is refused at `POST /devices/:id/sessions` (`409 unattended_denied` / `approval_required`) or waits for a local human. Device actions outside a session (§9) are under the same policy. | §6, §9.9, §13.3 |
| P5 | **Least privilege per action still holds.** The service runs as `LocalSystem` because capture/input across desktops and the lock screen need it, but every privileged *action* (a `requiresElevation` playbook, a secret injection, input lock, privacy screen) is still requested per action with a typed reason, logged, and gated on the session level `elevated` or, outside a session, on the action policy gate (§5, §9.8, §9.9). `LocalSystem` is the floor the OS forces for the capability, not a licence to skip the audit. | §5, §7 |
| P6 | **The relay stays blind.** Media is DTLS-SRTP, every data channel but `ia.sec` is XChaCha20-Poly1305 under per-session keys (C §1). The device-auth challenge and the enrollment handshake are the only new plaintext on the wire, and both are signatures, not secrets. | §3, §14 |
| P7 | **Visible when tampered, not silent.** A service that is stopped, disabled, deleted or whose binary changed raises an audited `tamper.alert` through an independent watchdog and, on next check-in, a backfilled event; a disabled agent is a visible fleet state, never an unexplained offline. | §10, §13.3 |
| P8 | **Honest about hardware gates.** AMT power-on works only where the hardware is present and provisioned; WoL works only with something awake on the subnet. Both report capability per device and the fleet view shows "available / not available", never a button that silently fails. | §8, §13.4 |

### 1.4 Architecture decision: service + session-0 bridge + desktop worker (binding)

A Windows service runs in session 0 and cannot draw on a user's desktop, capture it, or inject input into it directly; capture and `SendInput` must run **in the target interactive session** (the console session, or the secure/logon desktop). The binding shape (W28, rejecting "do everything in the service process"):

| Process | Runs as | Owns |
|---|---|---|
| **`ia-service`** (the service, one per machine) | `LocalSystem`, session 0, auto-start | the device identity and sealing keys (DPAPI-sealed), the persistent `/signal/device` WS connection and device-auth, the unattended-policy decision, the offline-action queue drain, the waker/AMT roles, the self-heal watchdog registration, opening server-sealed one-use secrets for injection (§9.8; the device holds no vault credential), and spawning/supervising the desktop worker |
| **`ia-desktop`** (the desktop worker, one per active session being shared) | the service launches it with `CreateProcessAsUser` into the target session, token from `WTSQueryUserToken` for an interactive session, or a `LocalSystem` token duplicated onto `Winsta0\Winlogon` / the secure desktop for the logon screen (§5.3) | the Phase C agent session logic (capture, encode, `ia.sec`, the seven channels, input injection, the pill/panel/tray, playbooks, voice) — it **is** the Phase C `ia-agent` serve loop reused, with the token/consent source replaced by an inherited handoff from the service (§4.2) |
| **`ia-watchdog`** (the self-heal watchdog) | a second service + a scheduled task (§10), `LocalSystem` | detect-and-restart/alert only; it holds no session state and no keys |

The service and the desktop worker talk over a named pipe (§4.2, same hardening family as C §7.2/§11.5). The desktop worker reuses C's `ia.sec`, codec, input and playbook code verbatim; what P4 adds is above it (identity, policy, desktop/secure-desktop selection, service-grade input) and beside it (waker, AMT, fleet). The rejected single-process design cannot touch the secure desktop or survive a user logoff, which is the whole point of Package 4.

---

## 2. Tiers, tokens and the fleet model

### 2.1 Tier and token types

`p4_installed` (A §2.1) becomes functional. Enrollment uses `typ = enrollment` on a `p4_installed` token (A §3.2: `p4_installed` only; 7 d default; the maximum is raised from 30 d to `TOKEN_LIFETIMES.enrollment.maxDays` = 180 d so a staged GPO rollout keeps enrolling late machines, §16.2). An enrollment token carries **`maxDevices`** (1..`LIMITS.enrollMaxDevices` = 10000, default 1, set at creation, `createTokenRequestSchema` += `maxDevices?` allowed only with `typ = enrollment`) and a server-side counter `devicesEnrolled`; it can enroll that many devices and no more, and an org_admin can revoke it at any time to stop further enrollments (devices already enrolled are unaffected: they no longer use the token). The attended P4 flow (a technician opens an *attended* session to an installed device) uses the device identity, not a fresh token (§3.5); `one_time` / `timed` P4 tokens are **not** minted for attended entry (W29: the device is the credential once enrolled). `PublicToken.joinSupported` stays `false` for `p4_installed` and `enrollment` (there is no `/join` browser page for P4; enrollment happens through the installer, §12), and `desk.hello` on a `p4_installed`/`enrollment` token still answers `join_unsupported` (A §3.5) — the service uses the new `device.*` messages on `/signal/device` (§3.4), never `desk.hello`; the per-session desktop worker sends `desk.hello` with a `workerCredential` and no token (§4.2).

### 2.2 Device, group and policy (binding shape)

| Object | Binding |
|---|---|
| **Device** | one row per enrolled machine (§13.2): identity and sealing keys, platform, agent/service version, capabilities (the service-grade features, waker, amt, amt_proxy), group, tags, unattended policy override, last-seen, interactive state, LAN segment, AMT inventory, tamper state |
| **Group** | an org-scoped named set of devices; carries the **default unattended policy** for its members and default tags; a device belongs to at most one group (`device.group_id`, nullable → the org's ungrouped default policy). The A placeholder column `device.group_name` is deprecated: never written or read in P4, kept for append-only migration safety, dropped in a later migration (§16.2). A group of one device is how a single device is scoped to named technicians (§7.1) |
| **Policy** | `UnattendedPolicy` (§6.1) lives on the group (default) and optionally on the device (override, `device.unattended_policy`); the effective policy is `device override ?? group ?? org default` resolved by shared `resolveUnattendedPolicy(device, group, orgDefault)` |

---

## 3. Enrollment and device identity (PRD 6, 7, 10)

### 3.1 Enrollment flow (binding)

1. An org_admin creates an **enrollment token** (`typ = enrollment`, tier `p4_installed`, §2.1) and, on the tokens page, sets `maxDevices` to the size of the rollout, picks the target group, and either downloads a **branded MSI** carrying the signed `enroll.iaconfig` (§12.3) or copies the same signed `enroll.iaconfig` (base64url) as the `IA_ENROLL` property for a deployment tool (GPO/Intune). The signed `enroll.iaconfig` is the **only** enrollment carrier: it binds the token, the region and the group under the region's signature (§12.3); a bare token is never accepted by the service.
2. The MSI installs the service as `LocalSystem`, auto-start, under `%ProgramFiles%\IndiansAssist\`.
3. On first start the service generates the device Ed25519 identity key pair and the X25519 sealing key pair (`ia-service::identity`), seals both private keys with DPAPI machine scope (§3.3), and reads the signed `enroll.iaconfig` placed beside the binary (or written from `IA_ENROLL` by the MSI) (filename/clipboard carriers of C §2.1 do **not** apply to the service; config comes from the sealed install config only).
4. The service calls `POST /api/v1/devices/enroll` (§3.2) with the signed `enroll.iaconfig`, both device public keys, a possession proof and machine facts. The server verifies the iaconfig signature, then the token inside it (A §3.5, `typ === 'enrollment'`, `tier === 'p4_installed'`), creates a `device` row bound to the token's org and region and to the iaconfig's group, binds `device.enrolled_by_token_id`, and **counts the enrollment against the token** (`devices_enrolled + 1` under a row lock; when it reaches `max_devices` the token goes `status → used`, `used_at` set, W30). It returns the `deviceId`, the region origin and the effective group/policy snapshot.
5. The service **deletes the enrollment material** — the `enroll.iaconfig` file (overwrite-and-remove, C §2.4 shred), the `IA_ENROLL` value the MSI cached, and the in-memory copy — the moment enrollment succeeds; from then on it holds only its `deviceId` and sealed keys. This is the PRD's "then discarded" for that device: the token is never presented again by it. A re-enroll (disk restore, re-image) needs an enrollment token with capacity left; the old device row is marked `superseded` if the same machine fingerprint re-enrolls (§3.7).

### 3.2 Enrollment endpoint (`apps/api`)

| Method / path | Auth | Request | Response |
|---|---|---|---|
| `POST /api/v1/devices/enroll` | none (the bearer is the enrollment token inside the signed `enrollConfig`; `X-Requested-With` required, no cookie, no `Origin`, A §6.1 accepts an absent `Origin`) | `{ enrollConfig: string (the signed enroll.iaconfig JSON verbatim, <= LIMITS.enrollConfigMaxBytes, §12.3), devicePublicKey: base64url(32), deviceKexPublicKey: base64url(32), deviceKeyProof: base64url(64) (identity-key signature, domain ia-enroll-v1, §3.8), machine: { name (<=80), platform: 'windows', osVersion (<=32), arch: 'x64'\|'arm64', serviceVersion, hwFingerprint: hex64, wakeMac: hex12 \| null, amt: AmtInventory\|null, capabilities: ServiceCapabilities, interactive: InteractiveState } }` | verifies `enrollConfig.sig` against the region token-signing key named by its `kid` (else `400 invalid_enroll_config`); runs A §3.5 on `enrollConfig.token`; requires `typ === 'enrollment'` and `tier === 'p4_installed'` (else `400 invalid_token_type`); `enrollConfig.groupId`, when present, must be a `device_group` of the token's org (else `400 invalid_group`); verifies `deviceKeyProof` with `devicePublicKey` (proves possession of the private key, else `400 token_bad_signature`); `status === 'active'` (else `410 token_gone`). Then, in one transaction with the token row locked (`SELECT ... FOR UPDATE`): `devices_enrolled < max_devices` (else `410 token_used`); create the `device` row (region = token region, `group_id = enrollConfig.groupId ?? null`, status `enrolled`, `kex_public_key`, MAC stored per §8.2c, `interactive` from the request); set `enrolled_by_token_id`; increment `devices_enrolled` and, when it reaches `max_devices`, set `status = 'used'`, `used_at`. N racing calls on a token with K enrollments left yield exactly K devices. `201 { deviceId, orgId (salts the LAN segment hashes, rule 8.2a), region, apiOrigin, signalUrl (the region's `/signal/device` URL, §3.4), keyId, group: { id, name } \| null, policy: UnattendedPolicy }`; audit `device.enrolled { deviceId, tokenId, keyId, platform, groupId, devicesEnrolled, maxDevices }` (actor system, `session_id` null). Rate limits: 60 / minute per IP and 120 / minute per token; a `429` is retried by the service with jittered backoff (C §3.1) so a NAT'd office enrolls in waves. |

### 3.3 Private key at rest (binding)

The device private keys (the Ed25519 identity key and the X25519 sealing key; the rules below apply to both, the sealing key in `%ProgramData%\IndiansAssist\device.kex`) are sealed with **DPAPI machine scope** (`CryptProtectData` with `CRYPTPROTECT_LOCAL_MACHINE`, via `ia_platform::sys_lib("crypt32")`, §C 14 late-binding) plus an additional entropy blob stored under the service's `HKLM\SOFTWARE\IndiansAssist\Device` key with an ACL granting only `SYSTEM` and `Administrators`; the sealed blob lives in `%ProgramData%\IndiansAssist\device.key` (ACL `SYSTEM`+`Administrators`, mandatory label `S:(ML;;NW;;;SI)`). DPAPI machine scope binds the blob to this machine, so a copied disk cannot unseal it on another host. The key is loaded into a `Zeroizing` buffer only to sign a challenge and is wiped after. It is **never** logged, exported, or sent on the wire (`device.key`, `device.kex`, `*.privkey` added to the redact list, §14).

### 3.4 Device signaling and auth (`/signal/device`, binding)

The service holds one persistent WS to `signalUrl`, which is a **separate upgrade path, `/signal/device`**, on the same api nodes (reconnect backoff as C §3.1 with ±30 % jitter, §13.5). The existing `/signal` upgrade (Assist, browser Desks, the C native agent, the recorder, and the P4 desktop worker of §4.2) is untouched: no device message is ever sent on `/signal`, so the C agent and the recorder never receive an unknown frame. `/signal/device` requires an **absent** `Origin` (a present `Origin` → HTTP 403 before the upgrade), ignores cookies, and accepts only the `device.*`, `wake.*` and `amt.*` messages this document defines; `assist.hello`, `desk.hello` or `recorder.hello` on it answer `error forbidden` + close `4403`.

| `t` | Dir | Payload | Notes |
|---|---|---|---|
| `device.challenge` | S→D | `{ serverChallenge: base64url(32), ts }` | sent by the server immediately after the `/signal/device` upgrade, exactly once per socket; a fresh challenge per socket prevents replay; no `device.hello` within 10 s → close `4408` |
| `device.hello` | D→S | `{ deviceId, keyId, nonce: base64url(16), sig: base64url(64) (identity key, domain `ia-dev-v1`, §3.8), client: { serviceVersion, agentVersion, osVersion, arch, capabilities: ServiceCapabilities, lanSegment: LanSegment, wakeMac: hex12 \| null, amt: AmtInventory\|null, interactive: InteractiveState } }` | the server verifies `sig` against `device.public_key` for `deviceId`; an unknown device, a `keyId` that is not `device.key_id`, or a bad signature → `error device_unauthenticated` + close `4412`; a `disabled`, `retired`, `superseded` or `deregistered` device → `error device_disabled` + close `4412` |
| `device.hello.ok` | S→D | `{ deviceId, orgDisplayName, region, policy: UnattendedPolicy, groupId \| null, queued: DeviceAction[] (<= LIMITS.deviceQueueDrainMax), playbooks: <the C §8.3 manifest shape>, rotationNonce: base64url(16) \| null }` | the server marks `device.last_seen_at`, `last_ip`, `online` in presence (`ia:dev:<deviceId>` TTL 90 s refreshed by `device.heartbeat`), updates mutable facts (versions, capabilities, lanSegment, wakeMac per §8.2c, amt, interactive), sets `first_seen_at` if null, and returns the queued actions (§9) and the org playbook manifest the device verifies queued `playbook_run` bodies against (§9.3) |
| `device.heartbeat` | D→S | `{ lanSegment?, wakeMac?, amt?, interactive?, metrics?: { cpu, mem, uptimeSec } }` | every 30 s ±5 s jitter; refreshes presence TTL and `last_seen_at`; a changed `lanSegment`/`wakeMac`/`amt` updates the row (used by the waker mesh) |
| `device.interactive` | D→S | `{ interactive: InteractiveState }` | sent within 2 s of any `WTS_SESSION_*` change (logon, logoff, lock, unlock, console connect/disconnect); updates `device.interactive` and feeds the live-session rules of §6.2 and the action gate of §9.9 |

**`InteractiveState`** (`fleet/device.ts`, strict) = `{ state: INTERACTIVE_STATES, idleSec: int >= 0 \| null, at: ts }` with `INTERACTIVE_STATES = ['none', 'locked', 'active']`: `none` = no user is logged on to the console session (the logon screen, pre-login); `locked` = a user is logged on but the console session is locked or disconnected; `active` = a user is logged on and unlocked at the console. **"Present"**, wherever §5, §6 and §9 use it, means `state === 'active'`. `idleSec` (from `GetLastInputInfo` in the console session) is shown in the fleet view only and never changes a policy decision: an idle, unlocked desktop counts as present, the safer reading.

A `device.hello` socket is registered as a **device presence**, distinct from a session Desk; it carries no session until the Assist opens one (§3.5). WS close codes gain **`4412`** (`WS_CLOSE.deviceUnauthenticated`), used for both `device_unauthenticated` and `device_disabled`; the preceding `error` code tells the service which. The service retries `device.hello` with backoff, except after `device_disabled`, which pauses retries to `LIMITS.deviceDisabledRetrySec` = 3600.

### 3.5 Opening a session to a device (attended or unattended)

| Step | Who | Message / rule |
|---|---|---|
| 1 | Assist | `POST /api/v1/devices/:id/sessions { reason: string (1..500, sanitised; **required when `unattended` is true**, optional otherwise), unattended: boolean, monitors?: number[] }` (RBAC §7.1). The server checks scope, that the Assist's seat tier covers `p4_installed`, that the device is `online` (else `409 device_offline` with a hint to `POST /wake`, §8), that the device has no live session (else `409 device_busy { sessionId }`, rule 3.5a), then applies the §6.2 decision table to the effective policy (§6) and the device's current `interactive` state: it either refuses (`409 unattended_denied` / `approval_required` / `nobody_present` / `outside_policy_window` / `recorder_required` / `prelogin_not_permitted`) or proceeds with a `decision` of `auto_grant`, `local_approval` or `local_consent` |
| 2 | server | in one transaction: creates the `session` row (`tier = 'p4_installed'`, `token_id` null, `device_id` set, `assist_user_id` = caller, `desk_ref` = the device's current connection id, `unattended`, the effective policy snapshot in `unattended_policy`, `recording_mode` raised to at least `server` when `recordingRequired`), writes `session.knock { deviceId, keyId }` and `session.accepted { deviceId, unattended, reason, onBehalfOf: null }` (the P4 branches of those chain schemas, §13.3); then mints a worker credential (§4.2) and pushes `device.session_open { sessionId, assist: { name }, reason, unattended, decision, policy, recordingMode, workerCredential, workerCredentialExpiresAt }` to the device socket through the owner node (rule 3.6c) |
| 3 | device | the service launches `ia-desktop` into the correct session/desktop (§5.3), which shows the pill immediately and acts on `decision` (§6.2): `auto_grant` → sends `desk.consent { native }` at once and the server writes `session.unattended_started { approvedBy: 'policy', ... }`; `local_approval` → the P4 approval card; `local_consent` → the C §3.3 consent window. Then the C §3.3-§3.4 consent path (`desk.consent { native }` reused, `surface: 'monitor'`) |
| 4 | both | from `active` onward the session is a C §3 session: `session.created` to the Assist with ICE, `ia.sec`, the seven channels, video, input, playbooks, recorder. For P4 `session.created` additionally carries `device: { id, name, keyId, publicKey }` and `unattended: boolean` (rule 3.5b needs the key). The Assist console is `AgentConsole` (C §13.4) with the P4 additions of §13.4 |

| # | Rule |
|---|---|
| 3.5a | **One live session per device.** A device has at most one non-ended session, enforced by the partial unique index `session_device_open_unique` on `session(device_id) WHERE state <> 'ended'` (§13.2); a second `POST /devices/:id/sessions` answers `409 device_busy { sessionId }` and the console shows who holds the device. A second technician joining a live device session waits for supervisor join (PRD 12.9; the A §4.1 `supervisor` participant, not built yet); it is not a second worker |
| 3.5b | **Security-code verification in P4** (C §1.3 step 7). When a person at the device answered the consent (`local_consent`, or `local_approval` with `approvedBy: 'local_user'`), the C read-out gate applies unchanged. When consent came without a person's answer (`approvedBy` `policy` or `auto_after_timeout`), nobody can be relied on to read the code out, so the gate is satisfied by **device-key attestation**: after each `ia.sec` key generation the worker asks the service, over the §4.2 pipe, to sign domain `ia-sas-v1` (§3.8) over the session id, `gen`, the SAS and both `sec.hello` fingerprints; the worker sends `ctl.event { kind: 'device_attest', gen, sig }` on the encrypted `ia.control` channel (`AGENT_CONTROL_EVENT_KINDS += 'device_attest'`, §16.2); the console verifies `sig` with `session.created.device.publicKey`, checks `kidOf(publicKey) === device.keyId`, then proceeds exactly as after a typed confirmation and posts `sec.verified { sas, gen, method: 'device_key' }` (actor user; `method` is a new optional field, absent = `read_out`). No valid attestation within 10 s of the new `gen` keeps the console in `view` with a blocking "This device's identity could not be verified — end the session" modal. Honest limit: the attestation binds the session keys to the enrolled device key; a signaling server that substituted both the fingerprints and the device public key it serves could defeat it (the same trust enrollment already places in the region server), so it is chained distinctly for auditors. `requireSasConfirm: false` still allows Skip, chained as in C. A user who arrives mid-session sees the SAS on the pill as in C (§6.2 arrival rule); no re-gate is forced |

An unattended session **never** requires a human at the Desk when the policy allows it; the indicator is still drawn (P3). `POST /devices/:id/sessions` replaces the "knock/accept" of attended tiers for P4; the WS `assist.accept`/`assist.deny` path is not used for a device (there is no knock to accept).

### 3.6 Device presence, reconnect and multi-node

| # | Rule |
|---|---|
| 3.6a | A connected device is a **presence**, not a session: `ia:dev:<deviceId>` = `{ connectionId, nodeId, region }` TTL 90 s, refreshed by `device.heartbeat` (30 s); the owning `nodeId` is the node holding the socket. `GET /devices/:id` folds `online` from this entry. A device that misses its grace (90 s) is `offline` in the fleet view, not ended (it has no live session unless one is open) |
| 3.6b | Reconnect: the service reconnects `/signal/device` with C §3.1 backoff (±30 % jitter) and re-runs `device.challenge`/`device.hello`; on reconnect it drains `device.hello.ok.queued` (§9), re-reports `lanSegment`/`wakeMac`/`amt`/`interactive` so a moved machine's segment is current, and re-sends any unacknowledged `device.tamper` events (§10.2) |
| 3.6c | Multi-node (A §7.6, `redis` driver): a `POST /devices/:id/*` that must reach the device socket is routed to the node holding it via the presence `nodeId` on the `node:<owner>` channel (the A bridge reused); `wake.send` / `amt.command` / `device.action` / `device.session_open` / `device.worker_credential` / `device.receipt` are delivered by the owner node. The offline-queue, wake-attempt and device rows live in the region database (A T1); any node in the region serves the REST calls |
| 3.6d | A live P4 **session** follows the C/A owner model (`session.node_id` = the node that opened it); a desktop-switch rebuild (§5.3) keeps the session on its owner. If the worker's `/signal` socket reconnects onto another node mid-session, its fresh worker credential (§4.2) adopts the session like a C resume (A §7.6 adoption) |

### 3.7 Re-enrollment, supersede and rotation

| # | Rule |
|---|---|
| 3.7a | A device whose `hwFingerprint` matches an existing `enrolled` device in the org, enrolling with an enrollment token that has capacity left, creates a **new** device row and marks the old one `superseded` (status enum value), writing `device.superseded { fromDeviceId, toDeviceId }`; the fleet view offers to merge tags/group. A re-image with a wiped key is thereby visible, not a silent duplicate. |
| 3.7b | Key rotation: `POST /api/v1/devices/:id/rotate-key` (org_admin) sets a one-time `device.rotation_nonce` (16 CSPRNG bytes); the next `device.hello.ok` carries it as `rotationNonce`; the device generates new identity and sealing key pairs and sends `device.rotate { newPublicKey, newKexPublicKey, oldKeySig, newKeyProof }` (D→S): `oldKeySig` by the current identity key (domain `ia-rot-v1`), `newKeyProof` by the new identity key (domain `ia-rot-new-v1`), §3.8. The server verifies both, swaps `public_key`/`key_id`/`kex_public_key`, clears the nonce, replies `device.rotate.ok { keyId }` (S→D) and writes `device.key_rotated { deviceId, fromKeyId, toKeyId }`; the device then wipes the old sealed keys. |
| 3.7c | A `disabled` device is kept (audit history references it); `DELETE` is a soft delete (`status = 'retired'`, key invalidated), audit `device.retired`; an uninstall's signed `POST /devices/:id/deregister` (§7.2) sets `status = 'deregistered'`, audit `device.deregistered` (actor device). `disabled`, `retired`, `superseded` and `deregistered` devices cannot `device.hello` (`4412`). |

### 3.8 Device signatures (binding byte strings)

All device signatures use `deviceSigningInput(domain, fields)` (conventions table). The fields, in order:

| Domain | Signed by | Fields (in order, with encoding) | Used in |
|---|---|---|---|
| `ia-enroll-v1` | new identity key | `tokenId` (UUID text), `devicePublicKey` (raw 32), `deviceKexPublicKey` (raw 32) | `deviceKeyProof`, §3.2 |
| `ia-dev-v1` | identity key | `deviceId` (UUID text), `serverChallenge` (raw 32), `nonce` (raw 16) | `device.hello.sig`, §3.4 |
| `ia-rot-v1` | current identity key | `deviceId`, `rotationNonce` (raw 16), `newPublicKey` (raw 32), `newKexPublicKey` (raw 32) | `device.rotate.oldKeySig`, §3.7b |
| `ia-rot-new-v1` | new identity key | `deviceId`, `rotationNonce` (raw 16), `oldKeyId` (16-hex ASCII) | `device.rotate.newKeyProof`, §3.7b |
| `ia-dereg-v1` | identity key | `deviceId`, `ts` (decimal ASCII ms), `nonce` (raw 16) | `POST /devices/:id/deregister`, §7.2 (the server rejects `ts` more than 300 s from now and a reused `nonce` within 600 s) |
| `ia-tamper-v1` | identity key | `deviceId`, `canonicalJsonBytes(event without sig)` | `TamperEvent.sig`, §10.5 |
| `ia-action-v1` | identity key | `deviceId`, `canonicalJsonBytes({ actionId, state, approvedBy?, result? })` (absent keys omitted) | `device.action_result.sig`, §9.7 |
| `ia-sas-v1` | identity key | `sessionId` (UUID text), `gen` (decimal ASCII), `sas` (6-digit ASCII), `deskFpr`, `assistFpr` (the exact `fpr` strings of the two `sec.hello`s, UTF-8) | `ctl.event device_attest`, rule 3.5b |

Verification is pure Ed25519 against `device.public_key`; a signature that fails verification is treated as absent (the message is rejected with `error device_bad_signature`, never partially applied).

---

## 4. The installed service and the desktop worker (Windows)

### 4.1 Service lifecycle

| Item | Binding |
|---|---|
| Install | service name `IndiansAssistAgent`, display "IndiansAssist Agent", `LocalSystem`, `SERVICE_AUTO_START`, delayed-auto-start off (it must be up before the logon screen for pre-login access), failure actions = restart after 5 s / 10 s / 60 s (`ia-service` registers these via `ChangeServiceConfig2`); a second service `IndiansAssistWatchdog` (§10) is `SERVICE_AUTO_START`, depends on nothing, and only watches |
| Crate | `ia-service` (`main.rs` as an SCM-aware binary via the `windows-service` crate, MIT/Apache-2.0): `SERVICE_CONTROL_STOP`/`SHUTDOWN`/`SESSIONCHANGE` handlers; on every `WTS_SESSION_*` change it sends `device.interactive` (§3.4) and re-evaluates which desktop a live session should target (§5.3) |
| Logs | `%ProgramData%\IndiansAssist\logs\service.log` (rotating 5 × 1 MiB), the C §6 redaction applies (SDP/ICE/tokens/keys/clipboard/playbook output/secrets never logged) |
| Config | `%ProgramData%\IndiansAssist\config.json` (ACL `SYSTEM`+`Administrators`): `apiOrigin`, `signalUrl`, `deviceId`, `keyId` (never the key), `wakerOptOut` and `amtProxyOptOut` (rules 8.2d, 8.4b; default false); written at install from the sealed `enroll.iaconfig`, never from an untrusted location |
| Uninstall | the MSI uninstall stops both services, calls `POST /api/v1/devices/:id/deregister` signed with the identity key (domain `ia-dereg-v1`, §3.8; §7.2) so the fleet shows `deregistered` ("Uninstalled"), not "offline" (an uninstall that cannot reach the server leaves the device to the §10.2 silent-past-grace rule, so it still surfaces), deletes the key blobs, the config and the `%ProgramData%` tree (received files in a user's Downloads are kept) |

### 4.2 Service ↔ desktop-worker handoff (binding)

The service launches `ia-desktop` and hands it a session over a named pipe `\\.\pipe\IndiansAssist.svc.<32 random hex>` created by the service with `FILE_FLAG_FIRST_PIPE_INSTANCE | PIPE_REJECT_REMOTE_CLIENTS` and a DACL granting `SYSTEM` and the launched worker's user SID only; the service verifies the client pid equals the process it launched and the image path equals its own `%ProgramFiles%` install path (same family as C §7.2). It writes one JSON blob `{ v: 1, sessionId, apiOrigin, signalUrl (the region's ordinary `/signal` URL, not `/signal/device`), assist: { name }, unattended: boolean, decision: 'auto_grant' \| 'local_approval' \| 'local_consent', policy, consent: { level, monitors, clipboard } \| null (set only for `auto_grant`), recordingMode, gen, deviceId, secureDesktop: boolean, workerCredential, workerCredentialExpiresAt }` then holds the pipe open for the session. The pipe is duplex: the worker sends desktop-switch requests and `sign_sas { gen, sas, deskFpr, assistFpr }` requests (rule 3.5b; the service answers `{ sig }`, so the identity key never enters the worker), and the service streams `SESSIONCHANGE` and `interactive` notifications back. To reuse the Phase C code unchanged, the **worker holds its own `/signal` socket**; the service never relays the worker's traffic.

**Worker credential** (W31). 32 CSPRNG bytes, base64url (43 characters), minted by the server and delivered to the service **only over the authenticated device socket**: inside `device.session_open` for `gen` 0, and in `device.worker_credential { sessionId, gen, workerCredential, expiresAt }` (S→D) in answer to `device.worker_credential.request { sessionId, gen }` (D→S) for each rebuild (§5.3) or worker reconnect (rule 3.6d). It is stored as `ia:wc:<sha256Hex(cred)>` = `{ sessionId, deviceId, gen }` with TTL `LIMITS.workerCredentialTtlSec` = 120 and is `Presence.consume`d on first use (single use). A request for a session that is ended or not on this device → `error bad_state`. The worker presents it as `desk.hello { workerCredential, client: { kind: 'native', tokenSource: 'service', ... } }` with **no `token`**: `deskHelloSchema` makes `token` optional, adds `workerCredential?: string (43 base64url characters)` and requires exactly one of the two, with `handover` allowed only beside `token`; `TOKEN_SOURCES` gains `service` (§16.2). The server consumes the credential, requires the session to be live with `device_id = deviceId` and `tier = 'p4_installed'`, requires the worker's `client.capabilities.features` to be a subset of the device row's `capabilities.features` (else `error capability_mismatch` + close `4403`), and then registers the socket as the session's Desk through the same code as the C §7.2 hand-over registration (a previous Desk socket of the session is closed `4411`). A token-less `desk.hello` with a missing, spent or expired credential → `error unauthenticated` + close `4401`. This keeps `ia-agent`'s serve loop byte-for-byte.

### 4.3 Reusing the Phase C agent

`ia-desktop` **is** the Phase C `ia-agent` serve loop with three seams replaced through the `ia-platform` traits and the launch blob:

| Seam | Phase C | Phase D |
|---|---|---|
| Token source | C §2.1 carriers | the launch blob's worker credential only (§4.2) |
| Consent source | C §3.3 window / `--auto-consent` | the server's `decision` in the blob (§6.2): `auto_grant` → immediate native consent + receipt; `local_approval` → the P4 approval card; `local_consent` → the C §3.3 window |
| Capture target | the signed-in user's desktop | the desktop the service selected (console session, or the secure/logon desktop, §5.3) |

Elevation hand-over (C §7) is **not used** in P4: the worker is already `LocalSystem` (or runs on the secure desktop), so admin windows and the UAC desktop are reachable without a relaunch. The console's "Request elevation" becomes "Request privileged mode" and simply sets `session.consent_level = 'elevated'` after the policy/approval check (§5.2), with no process relaunch; `elevation.request` on `ia.control` is answered by raising the level in place (W32).

---

## 5. Service-grade capabilities (the C §7.4 / W9 deferrals)

### 5.1 Secure-desktop and lock-screen capture (binding)

| # | Rule |
|---|---|
| 5.1a | Because `ia-desktop` can run as `LocalSystem` on the input desktop, DXGI Desktop Duplication captures the **logon screen** (nobody logged on, pre-login), the **secure desktop** (UAC consent, Ctrl+Alt+Del) and the **lock screen** of a logged-on user; C §4.1's "secure desktop delivers nothing" limit is lifted for P4 (`ctl.event capture { cause: 'secure_desktop' }` is no longer sent as a dead-frame signal; instead the worker switches its capture to the secure desktop, §5.3) |
| 5.1b | The worker enumerates and selects desktops with `OpenInputDesktop`/`SetThreadDesktop`; on a `WTS_SESSION_LOCK`/secure-desktop transition the service notifies the worker, which re-points capture and input at `Winlogon`/`Secure Desktop` and forces a keyframe; the console shows "User is at the Windows sign-in / security screen" (informational, no longer a block) |
| 5.1c | Two separate gates (PRD "boot time and pre login access", W28/W42). **Pre-login** (`interactive.state === 'none'`): governed by `allowLogonScreen` (default **false**). When false, `POST /devices/:id/sessions` answers `409 prelogin_not_permitted` and no worker is launched onto `Winlogon`; when true, the worker runs on the logon desktop at the session's level (`control` suffices: the logon screen shows no user content). **Secure desktop of a logged-on user** (a UAC prompt, the lock screen, Ctrl+Alt+Del): allowed only when `session.consent_level === 'elevated'` **and** `allowSecureDesktop` is true (default **false**); otherwise the worker holds the last pre-secure-desktop frame, shows "Windows security screen (hidden by policy)", and answers input with `ctl.res` error `secure_desktop`. Every capture window on either surface writes `capture.secure_desktop { surface: 'logon' \| 'uac' \| 'lock', durationMs }` (desk) so it is on the record. A user who logs on during a pre-login session triggers the §6.2 arrival rule and a §5.3 rebuild onto their desktop |

### 5.2 Service-grade input and privileged mode

| # | Rule |
|---|---|
| 5.2a | Input injection runs in the worker on the input desktop, so `SendInput` survives UAC dialogs and reaches the secure desktop; UIPI never blocks it (same-or-higher integrity). `Ctrl+Alt+Delete` (the SAS) still cannot be injected by any process (C §5.4); the console shows a **Send Ctrl+Alt+Del** button that calls a privileged action (`os.sas`, §5.4) the service performs via `SendSAS` (the standard service-only API), gated on `elevated` (privileged mode, which itself needs `allowPrivileged`, rule 5.2b) |
| 5.2b | "Privileged mode" (the P4 name for C's elevation) is reached by `elevation.request { reason }` on `ia.control` (the reason is chained through the existing `elevation.requested` reason path, C §3.8); the worker checks the effective policy's `allowPrivileged` (false → `elevation.denied { cause: 'policy' }`) and, **whenever a user is present** (§3.4), shows the local approval card for privileged mode (technician, reason; Allow/Decline, physical-input gated); with nobody present `allowPrivileged` alone suffices. On success `session.consent_level → 'elevated'` **with no process relaunch** (W32), audit `elevation.granted { opId, elevation: 'admin', claimed: true, mode: 'service' }` (`mode` is a new optional field of that chain schema, absent = `handover`, §16.2). Dropping back to `control`/`view` re-imposes the input/feature restrictions by policy (C §3.4 lower rule reused) |

### 5.3 Desktop selection state (binding)

The service drives which desktop the worker targets:

| Machine state | Target desktop | Worker token |
|---|---|---|
| A user is logged on and at the console, unlocked (`interactive.state = 'active'`) | `WinSta0\Default` of the console session | `WTSQueryUserToken(consoleSessionId)` → `CreateProcessAsUser` |
| A user is logged on but the session is locked, or a UAC prompt is up (`locked`, or `active` with the secure desktop as input desktop) | `WinSta0\Winlogon` (secure desktop) | `LocalSystem` duplicated onto the secure desktop; frames and input flow only under the second gate of rule 5.1c (`elevated` + `allowSecureDesktop`), otherwise the held frame and "hidden by policy" |
| No user logged on, pre-login (`none`) | `WinSta0\Winlogon` (logon desktop) | `LocalSystem` on the logon desktop; reachable only when `allowLogonScreen` is true (first gate of rule 5.1c), otherwise the session was refused at `POST` with `409 prelogin_not_permitted` |
| Fast-user-switch / RDP session change | re-evaluate on `WTS_SESSION_*` | the service kills and relaunches the worker for the new session with a fresh worker credential (§4.2), preserving the session (a C §3.7 rebuild with `gen+1`; the new SAS is re-confirmed by read-out or device-key attestation, rule 3.5b) |

### 5.4 Input lock and privacy screen (binding; `os.input_lock`, `os.privacy_screen` now supported)

C §5.1 defined these as `not_supported { message: 'phase_d' }`. In P4 they are supported:

| `op` | `args` | `result` | Min level | Audit |
|---|---|---|---|---|
| `os.input_lock` | `{ locked: boolean }` | `{ locked }` | `elevated` | `input.lock_changed { locked, cause }` (desk) |
| `os.privacy_screen` | `{ on: boolean }` | `{ on }` | `elevated` | `privacy.screen_changed { on, cause }` (desk) |
| `os.sas` | `{}` | `{}` (sends Ctrl+Alt+Del via `SendSAS`) | `elevated` | `input.sas_sent {}` (desk) |

`os.sas` is a new op: `AGENT_CONTROL_ARGS['os.sas'] = z.strictObject({})`, `MIN_LEVEL['os.sas'] = 'elevated'`, not a `control.input` kind, mirrored in `ia_core::types` and `agent-names.json` (§16.2). On a P3 session it answers `not_supported { message: 'phase_d' }`. `cause` (`LOCK_CHANGE_CAUSES = ['technician', 'user_sas', 'level_drop', 'teardown', 'session_end', 'user_declined']`) says who turned the feature on or off.

Input lock blocks the local physical keyboard/mouse while the technician works (a low-level block the service can enforce because it owns the input desktop: `BlockInput` in the worker, which the sitting user can always break with Ctrl+Alt+Del; the service un-locks on it and chains `cause: 'user_sas'`). Privacy screen blanks the physical monitors to a branded "Maintenance in progress" overlay while the stream continues. Binding rules for both:

| # | Rule |
|---|---|
| 5.4a | **Policy-gated**: `allowInputLock` / `allowPrivacyScreen`, default **false**; a request under a false flag answers `ctl.res` error `not_allowed` (an existing `CONTROL_ERROR_CODES` value) |
| 5.4b | **The consent indicator stays visible**: the privacy overlay is a layered window placed *below* the pill, which stays topmost; the overlay itself shows "Remote maintenance by <technician name> (<org>) — this screen is hidden while they work" and "Press Ctrl+Alt+Del to end"; while input lock is on, the pill and a banner show "Input locked by <technician name>" and the same escape. Neither feature can hide the pill, tray icon or recording dot |
| 5.4c | **Present user asked first**: when a user is present (§3.4) at the moment of the request, turning either feature on shows the local approval card ("<technician> wants to lock your keyboard and mouse" / "hide your screen while they work", Allow/Decline, physical-input gated); Decline answers `ctl.res` error `refused` and chains `cause: 'user_declined'` with the state unchanged. With nobody present the policy flag alone suffices (the PRD's "for unattended work") |
| 5.4d | **Fail-open release**: both are released on technician toggle-off, the user's Ctrl+Alt+Del, a level drop below `elevated`, teardown, session end and worker loss; each release the worker performs is chained with its `cause`. When the worker dies the OS drops `BlockInput` and the overlay with the process; the server, which tracks the last reported state, writes `session.protections_released { inputLock, privacyScreen }` (actor system) when the worker's socket drops while a feature was on |

The console `AgentStats`/`InputModeToggle` show the live state; the pill shows a lock/privacy glyph.

### 5.5 Honest limits that remain

| Limit | Note |
|---|---|
| The SAS keystroke still cannot be *injected* | only `SendSAS` from the service triggers it; injecting `Ctrl+Alt+Del` is impossible by OS design (C §5.4), so `os.key` still answers `not_supported { message: 'sas' }` for that combination |
| BitLocker pre-boot PIN / firmware password screens | before Windows loads, only AMT SOL (§8.4) can show it, read-only; the service is not running yet |
| A machine that is fully off | needs WoL or AMT power-on first (§8); the service cannot capture what is not booted |

---

## 6. Unattended policy and consent (PRD 7)

### 6.1 `UnattendedPolicy` (shared `fleet/policy.ts`, strict)

```json
{ "mode": "allow", "requireLocalApprovalWhenPresent": true, "autoAllowAfterSec": null,
  "allowedHours": { "tz": "Asia/Kolkata", "windows": [{ "days": [1,2,3,4,5], "from": "09:00", "to": "18:00" }] },
  "recordingRequired": true, "allowLogonScreen": false, "allowSecureDesktop": false, "allowPrivileged": true,
  "allowInputLock": false, "allowPrivacyScreen": false, "allowAmtSol": false, "allowAmtBootRedirect": false,
  "notifyLocalUser": true, "maxUnattendedMinutes": 120 }
```

`unattendedPolicySchema` is strict and **every key is required**; `allowedHours` and `autoAllowAfterSec` are the only nullable keys. The org default (`org.unattended_policy`) is a full policy. A group's `default_policy` and a device's `unattended_policy` override are `unattendedPolicyPatchSchema` (the same keys and value rules, every key optional, strict). `resolveUnattendedPolicy(device, group, orgDefault)` = `{ ...orgDefault, ...group.defaultPolicy, ...device.unattendedPolicy }`, then re-validated with the full schema.

| Field | Rule |
|---|---|
| `mode` | `UNATTENDED_MODES = ['allow', 'approval_only', 'deny']`: `allow` = unattended entry permitted (subject to the rest of this table); `approval_only` = a person at the device must approve each unattended session (used for sensitive groups); `deny` = no unattended entry at all; only an attended request (`unattended: false`) to a present user, who consents exactly as in C |
| `requireLocalApprovalWhenPresent` | with `mode = allow`, when a user **is** present (§3.4), show them the approval card instead of auto-granting (do not take over a machine someone is using without a nod); with nobody present, `allow` proceeds |
| `autoAllowAfterSec` | `null` (default) or 10..120; only meaningful with `mode = allow` and `requireLocalApprovalWhenPresent`: the approval card counts down and, if nobody answers, allows (chained `approvedBy: 'auto_after_timeout'`). An `approval_only` card never auto-allows |
| `allowedHours` | `null` = any time; otherwise `{ tz: IANA zone, windows: 1..14 × { days: ISO weekdays 1..7 (Mon = 1), from: 'HH:MM', to: 'HH:MM' } }` with `from < to` (an overnight window is written as two windows); applies to unattended sessions and to device actions (§9.9); outside every window → `409 outside_policy_window`. Attended requests (`unattended: false`) ignore it. `isWithinPolicyWindow(policy, now)` is the one implementation |
| `recordingRequired` | when true the session forces `recordingMode` to at least `server` (A.2) and refuses to start if the recorder cannot be assigned (`409 recorder_required`) |
| `allowLogonScreen` | pre-login access (no user logged on), first gate of rule 5.1c; default false |
| `allowSecureDesktop` | UAC prompts and the lock screen of a logged-on user, second gate of rule 5.1c (also needs `elevated`); default false |
| `allowPrivileged` / `allowInputLock` / `allowPrivacyScreen` | per-capability gates (§5.2, §5.4) and the privileged-action gate of §9.9 |
| `allowAmtSol` / `allowAmtBootRedirect` | out-of-band AMT Serial-over-LAN console and boot-device redirection (§8.4); default false |
| `notifyLocalUser` | show a toast "IndiansAssist session started by <technician>" in addition to the pill when a session starts with nobody having approved it; the pill itself can never be turned off — this only controls the extra toast. A user who is present always gets the §6.2 notice or approval card regardless of this flag |
| `maxUnattendedMinutes` | int `0..LIMITS.maxUnattendedMinutesCap` (1440); the session auto-ends with `endReason = 'policy_timeout'` after this many minutes during which the session was auto-granted and nobody was present; the clock pauses while a present user has chosen **Continue** (rule 6.2a); 0 = no cap |

The org default ships as `DEFAULT_UNATTENDED_POLICY = { mode: 'approval_only', requireLocalApprovalWhenPresent: true, autoAllowAfterSec: null, allowedHours: null, recordingRequired: true, allowLogonScreen: false, allowSecureDesktop: false, allowPrivileged: true, allowInputLock: false, allowPrivacyScreen: false, allowAmtSol: false, allowAmtBootRedirect: false, notifyLocalUser: true, maxUnattendedMinutes: 120 }` (safe by default: approval required until an admin opts a group into `allow`; pre-login, secure desktop, input lock, privacy screen and AMT console stay off until opted in, W42).

### 6.2 Consent decision at session open (binding)

The server decides at `POST /devices/:id/sessions` from the effective policy and the device's last reported `interactive` state (§3.4). Checks run in this order: `device_offline`, `device_busy`, the table below, then for `unattended: true` sessions `allowedHours` and the pre-login gate (`interactive.state === 'none'` and not `allowLogonScreen` → `409 prelogin_not_permitted`), and for every P4 session `recorder_required` (`recordingRequired` applies to attended and unattended sessions alike).

| `unattended` | `mode` | Present? | Answer at `POST` | `decision` and what the worker does |
|---|---|---|---|---|
| `false` | any | yes | proceed | `local_consent`: the C §3.3 consent window; the user consents exactly as in C; no `session.unattended_started` |
| `false` | any | no | `409 nobody_present` | — |
| `true` | `deny` | any | `409 unattended_denied` (the console offers an attended request when someone is present) | — |
| `true` | `approval_only` | yes | proceed | `local_approval`: the P4 approval card (technician, org, reason, "Allow this remote session", **Allow**/**Decline**, physical-input gated as C §3.5, no auto-allow); Allow → `desk.consent { native }` + `session.unattended_started { approvedBy: 'local_user' }`; Decline, or no answer within `LIMITS.localApprovalTimeoutSec` (60) → `session.ended { endReason: 'consent_required' }` |
| `true` | `approval_only` | no | `409 approval_required` ("This group requires someone at the device to approve") | — |
| `true` | `allow` | yes, and `requireLocalApprovalWhenPresent` | proceed | `local_approval` as above; with `autoAllowAfterSec` set the card counts down and auto-allows (`approvedBy: 'auto_after_timeout'`), otherwise no answer → `consent_required` |
| `true` | `allow` | yes, approval not required | proceed | `auto_grant`, and the present user is always shown the notice card "<technician> (<org>) started a remote session. Reason: <reason>. [End session]" beside the pill |
| `true` | `allow` | no | proceed | `auto_grant`: the worker sends `desk.consent { native: { level: 'control', monitors: [all], clipboard: false } }` immediately; the server writes `session.unattended_started { approvedBy: 'policy', policySnapshot, reason }`; pill + (if `notifyLocalUser`) the toast |

If presence changes between `POST` and the worker's launch, the worker follows the live state: an `auto_grant` that now finds a present user applies rule 6.2a at once; a `local_approval`/`local_consent` that finds nobody times out to `consent_required`.

| # | Rule |
|---|---|
| 6.2a | **A user arrives mid-session.** When a session whose consent was `auto_grant` (or a pre-login session) sees the device become present (`device.interactive`, §3.4), the worker shows, beside the pill and on the user's desktop after any §5.3 rebuild, the arrival card "<technician> (<org>) is in a remote session on this computer, authorised by your organisation's policy. Reason: <reason>. [End session] [Continue]". With `requireLocalApprovalWhenPresent` the session drops to `view` (C §3.4 lower rule; input lock and privacy screen release with `cause: 'level_drop'`) until **Continue**; without it the session keeps its level and the card stays until dismissed. **End session** is always available and revokes consent through the C revoke path (`endReason: 'consent_revoked'`). The `maxUnattendedMinutes` clock pauses once the user chooses Continue. The worker reports the user's choice as `desk.event session.local_user_arrived { decision: 'continue' \| 'ended', levelDroppedTo: 'view' \| null }` (chained, §13.3); a card left unanswered writes nothing extra, and the session's receipt shows the arrival time from the `device.interactive` history |
| 6.2b | In every case the pill, tray and recording dot are drawn (P3), and the receipt of §6.4 is produced |

### 6.3 Audit for unattended

New actions (§13.3): `session.unattended_started { approvedBy: 'policy' \| 'local_user' \| 'auto_after_timeout', policySnapshot, reason }`, `session.local_user_arrived`, `capture.secure_desktop`, `input.lock_changed`, `privacy.screen_changed`, `input.sas_sent`, `consent.receipt_sent`. `device.session_open` is not chained (it is a push; the chain has `session.knock`/`session.accepted`). `SESSION_END_REASONS` gains `consent_required`, `policy_timeout` and `device_disabled` (§16.2; `consent_required` was only an error code before).

### 6.4 Consent receipts for device sessions and actions (PRD 12.14)

| # | Rule |
|---|---|
| 6.4a | **Built by the server from the chain.** At session end the api builds a `DeviceReceipt` (`fleet/receipt.ts`): the C §3.5 receipt fields (A D6 plus `monitorsShared`, `levelChanges`, `clipboard`, `elevation`, `playbooks`, `sas[]`) plus `deviceId`, `deviceName`, `technician: { name }`, `reason`, `unattended`, `approvedBy`, `policySnapshot`, `secureDesktop: { surface, durationMs }[]`, `inputLock` and `privacyScreen` on/off windows, `recording: { mode, recordingId \| null }`, `startedAt`, `endedAt`, `endReason`. For each finished device action (§9) it builds a `DeviceActionReceipt` `{ actionId, kind, name, technician, reason, approvedBy, state, startedAt, completedAt }`. The worker's local C receipt still appears for a present user; the server receipt is the record for every P4 session and action |
| 6.4b | **Delivered to the device.** S→D `device.receipt { receipt: DeviceReceipt \| DeviceActionReceipt }` (through the owner node; held and re-sent on reconnect if the device is offline). The service keeps receipts under `%ProgramData%\IndiansAssist\receipts\` (ACL: `SYSTEM` and `Administrators` full, interactive users read; 90 days or 500 entries). At the next logon or unlock after any receipt arrived while nobody was present, the service shows a toast "N remote sessions or actions happened on this computer while you were away" that opens a **Remote activity** viewer, also on the tray menu |
| 6.4c | **Emailed.** For unattended sessions (`approvedBy` `policy` or `auto_after_timeout`) and for every device action, the receipt is mailed to `device.notify_email ?? device_group.notify_email ?? null` (null = no mail; the local record of 6.4b still exists). Action receipts are batched into one mail per device per `LIMITS.receiptDigestMinutes` (60) |
| 6.4d | **Mailer.** `apps/api/src/mail/*`: interface `Mailer.send({ to, subject, text, attachments: [{ name: 'receipt.json', json }] })`, drivers `log` (default: writes a redacted line, for development and self-hosts without SMTP) and `smtp` (nodemailer, MIT-0); env `MAIL_DRIVER` (`log` \| `smtp`), `SMTP_URL`, `MAIL_FROM` |
| 6.4e | **Audited.** Every delivery writes `consent.receipt_sent { sessionId \| null, actionIds: uuid[], channel: 'email' \| 'device', toHash: hex \| null (pepperedHash of the address), delivered: boolean, cause?: 'no_address' \| 'no_mailer' \| 'send_failed' }` (actor system) |

---

## 7. Fleet management (REST, RBAC, audit)

### 7.1 Roles

The A §2.2 roles are reused. New capability rows (A §2.3 matrix extended, §16.2):

| Capability | technician | senior_technician | org_admin | auditor | observer |
|---|---|---|---|---|---|
| devices list / get | own-group* | org | org | org | org (no live actions) |
| device session open (`POST /devices/:id/sessions`) | own-group | org | org | no | no |
| device wake / AMT power-on (`POST /devices/:id/wake`) | own-group | org | org | no | no |
| AMT SOL console / boot redirect (`POST /devices/:id/amt/*`, §8.4) | no | org | org | no | no |
| device action run / cancel (`/devices/:id/actions`) | own-group | org | org | no | no |
| device enroll config / MSI download | no | no | org | no | no |
| device disable / retire / rotate-key / tamper acknowledge | no | no | org | no | no |
| groups + policy CRUD, technician group assignment, fleet settings | no | no | org | no | no |
| offline queue list | own-group | org | org | org | no |
| fleet residency counts | no | no | org | org | no |

\* **"own-group"** depends on the org setting `org.fleet_scoping_enabled` (default **false**, set by org_admin through `PATCH /orgs/current/policy/fleet`). While it is false, a technician's device scope is the whole org (the small-org behaviour) and `user.device_group_ids` is ignored. Once it is true, a technician's scope is exactly the groups in `user.device_group_ids`; `null` and `[]` both mean **no devices** (fail closed), and ungrouped devices are reachable only by senior_technician and org_admin. **Per-device scoping** (PRD 7) is a group of one device assigned to the named technicians; no separate per-device ACL is built (W43). Assignment changes are chained `user.device_groups_changed { userId, groupIds }`. Cross-org device id → `404 not_found` (A §2.3). An own-group failure within the org → `403 forbidden`.

### 7.2 Endpoints (`apps/api/src/fleet/*`)

| Method / path | Roles | Request | Response |
|---|---|---|---|
| `GET /api/v1/devices` | per §7.1 | `?group=&tag=&status=&online=&q=&limit&cursor` | `200 Page<Device>` (§13.1 wire); `online` folded from presence; cursor `<lastSeenAt>\|<id>` |
| `GET /api/v1/devices/:id` | scope | | `200 Device & { group, policy: UnattendedPolicy (effective), amt: AmtInventory \| null, recentSessions: SessionSummary[] }` |
| `PATCH /api/v1/devices/:id` | org_admin | `{ name?, groupId?, tags?, unattendedPolicy?: UnattendedPolicyPatch \| null, notifyEmail? }` | `200 Device`; `(id, org_id)` load, 404 cross-org; audit `device.updated { deviceId, fields }` |
| `POST /api/v1/devices/:id/disable` / `/enable` | org_admin | | `200 Device`; disable closes the device socket `4412` (`error device_disabled`), ends any live session with `endReason: 'device_disabled'`, refuses new sessions; audit `device.disabled`/`device.enabled` |
| `DELETE /api/v1/devices/:id` | org_admin | | `204` soft retire (rule 3.7c); audit `device.retired` |
| `POST /api/v1/devices/:id/rotate-key` | org_admin | | `200 { rotationArmed: true }`; audit `device.key_rotation_armed { deviceId }` |
| `POST /api/v1/devices/:id/deregister` | device (no cookie; body signed with the identity key, domain `ia-dereg-v1`, §3.8) | `{ ts, nonce: base64url(16), sig: base64url(64) }` | `204`; sets `status = 'deregistered'`, closes the device socket; audit `device.deregistered { deviceId }` (actor device). 10 / minute per IP; a bad signature, stale `ts` or reused `nonce` → `401 device_unauthenticated` |
| `POST /api/v1/devices/:id/sessions` | scope | `{ reason: string (1..500; required when unattended), unattended: boolean, monitors? }` | `201 { sessionId }` or `409 device_offline` / `device_busy` / `nobody_present` / `unattended_denied` / `approval_required` / `outside_policy_window` / `prelogin_not_permitted` / `recorder_required` (§3.5, §6.2); audit `session.knock` + `session.accepted`, then (at `active`, unattended only) `session.unattended_started` |
| `POST /api/v1/devices/:id/wake` | scope | `{ method?: 'wol' \| 'amt' \| 'auto' (default auto), reason?: string (<= 500) }` | `202 { wakeId, method, via }` (§8); audit `device.wake_requested { deviceId, wakeId, method, reason }` |
| `POST /api/v1/devices/:id/amt/sol` | senior_technician, org_admin (scope) | `{ reason: string (1..500) }` | `201 { solId, via }` or `409 amt_unavailable` / `policy_forbidden` (`allowAmtSol` false); §8.4; audit `device.amt_sol_opened { deviceId, solId, viaDeviceId, reason }` |
| `POST /api/v1/devices/:id/amt/sol/:solId/close` | the opener or org_admin | | `200`; audit `device.amt_sol_closed { deviceId, solId, durationMs }` |
| `POST /api/v1/devices/:id/amt/boot` | senior_technician, org_admin (scope) | `{ target: AMT_BOOT_TARGETS, reason: string (1..500) }` | `202 { cmdId, via }` or `409 amt_unavailable` / `policy_forbidden` (`allowAmtBootRedirect` false); audit `device.amt_boot_redirected { deviceId, cmdId, target, viaDeviceId, reason }` |
| `POST /api/v1/devices/:id/actions` | scope | `{ kind: DeviceActionKind, payload, reason?: string (1..500) }` (§9); `reason` is **required** for a `playbook_run` with `requiresElevation` or `vaultRefs`, and for a `print` naming a non-default `printer` | `202 { actionId, state: 'queued' \| 'dispatched' }` or `409 unattended_denied` (policy `mode = deny`, §9.9); audit `device.action_queued { actionId, deviceId, kind, reason }` |
| `GET /api/v1/devices/:id/actions` | scope | `?state&limit&cursor` | `200 Page<DeviceAction>` |
| `POST /api/v1/devices/:id/actions/:actionId/cancel` | scope | | `200 DeviceAction`; audit `device.action_cancelled { actionId, deviceId, kind }` |
| `POST /api/v1/devices/:id/tamper/acknowledge` | org_admin | `{ note?: string (<= 500) }` | `200 Device` (`tamper_state → ok`); audit `tamper.acknowledged { deviceId, cause, note }` |
| `GET/POST/PATCH/DELETE /api/v1/orgs/current/device-groups[/:id]` | org_admin (GET any device-scope role) | group + default policy (`UnattendedPolicyPatch`) + tags + notifyEmail | `200/201/204`; audit `device_group.created/updated/deleted { groupId, fields? }` |
| `PUT /api/v1/orgs/current/users/:id/device-groups` | org_admin | `{ groupIds: uuid[] \| null }` | `200 User`; audit `user.device_groups_changed { userId, groupIds }` |
| `GET/PATCH /api/v1/orgs/current/policy/unattended` | org_admin (GET any role) | the org default `UnattendedPolicy` (full) | `200`; audit `org.policy_updated { fields: ['unattended'] }` (B naming reused) |
| `GET/PATCH /api/v1/orgs/current/policy/fleet` | org_admin (GET any role) | `{ fleetScopingEnabled?: boolean, wakerMeshEnabled?: boolean }` | `200`; audit `org.policy_updated { fields }` |
| `GET /api/v1/devices/enroll-config` | org_admin | `?tokenId=&groupId=` (an `active` `enrollment` token of the org; a group of the org) | `200 { iaconfig: string (signed enroll.iaconfig) }` for the MSI transform or `IA_ENROLL` (§12.3); audit `device.enroll_config_issued { tokenId, groupId }` |
| `GET /api/v1/orgs/current/residency` | org_admin, auditor | | extended (A §6.3) with `devices`, `onlineDevices`, `unattendedSessions30d`, `wakeAttempts30d`, `deviceActions30d`, `amtPlainHttpDevices` |

All device-scoped routes use `scopedDevice(ctx, p, id)` (the A `scopedSession` analogue: `(id, org_id = p.org.id)` load else 404, then the §7.1 group/role check else 403). The deregister route is the only device-authenticated REST call; every other device interaction is on `/signal/device`.

### 7.3 RBAC summary

Device create happens only through enrollment (§3.2), never a REST POST. Everything mutating policy, groups, group assignment, fleet settings, enable/disable/retire/rotate and tamper acknowledgement is org_admin. Running a session, waking, and queueing actions follow the own-group/org split; the out-of-band AMT console and boot redirect are senior_technician or org_admin only. Auditor is read-only across the fleet. Observer sees the device list and status but can take no live action and sees no audit export.

---

## 8. Wake on LAN, the waker mesh, and AMT power-on (PRD 12.5, 15.3)

### 8.1 Wake resolution (`POST /devices/:id/wake`, binding)

| Step | Rule |
|---|---|
| W1 | `method: 'auto'` tries, in order: (1) AMT if the device's `amt.present && amt.provisioned` and an online **AMT proxy** exists for it (§8.4), (2) WoL via a waker peer (§8.2); `method: 'wol'`/`'amt'` force one path. The target device itself is offline (that is why it needs waking), so the server acts through other online devices |
| W2 | The server records a `wake_attempt` row (`wakeId`, method, via, state `pending`), returns `202 { wakeId, method, via }`, and resolves asynchronously. The console polls `GET /devices/:id` (presence flips to online when the woken device's service reconnects) and also receives the S→A pushes `device.woke { wakeId, deviceId, method, via, elapsedMs }` and `device.wake_failed { wakeId, deviceId, cause }`, sent on `/signal` to every connection of the requesting user |
| W3 | Success = the target `device.hello`s within `LIMITS.wakeConfirmSec` (120); the attempt is marked `woke`, audit `device.woke { deviceId, wakeId, method, via, elapsedMs }`. Failure marks it `failed` with a cause from `WAKE_FAIL_CAUSES = ['no_waker', 'no_confirm', 'amt_unavailable', 'amt_unreachable', 'waker_error']` and writes `device.wake_failed { deviceId, wakeId, method, cause }` (actor system); `no_confirm` = the packet or AMT command was sent but the machine did not come up (honest, P8) |

### 8.2 LAN waker mesh (binding)

| # | Rule |
|---|---|
| 8.2a | Every online P4 device reports a **`LanSegment`** in `device.hello`/`device.heartbeat`: `{ subnetHash: hex64, gatewayMacHash: hex64, dhcpDomain?: string }`, computed locally so raw addresses are never sent: `subnetHash = sha256Hex(utf8("ia-seg-v1/" + orgId + "/" + <IPv4 /24 CIDR> + "/" + <default-gateway MAC, lower-case colon form>))`, `gatewayMacHash = sha256Hex(utf8("ia-gw-v1/" + orgId + "/" + <gateway MAC>))` (the org salt stops cross-org correlation; `orgId` comes from the enroll reply). Devices sharing a `subnetHash` are a **segment**; the server groups them in presence (`ia:seg:<subnetHash>` → set of online deviceIds) |
| 8.2b | To WoL a target, the server reads the target's last-known `subnetHash` (`device.lan_segment`, updated at each heartbeat), elects the online device in that segment that advertises the `waker` feature, has not opted out, and has the most recent heartbeat, and pushes `wake.send { wakeId, targetMacSealed: Sealed }` to it; the waker opens `targetMacSealed` with its sealing key (purpose `wake-mac`, conventions), emits the magic packet (UDP 9 to the subnet broadcast address and to `255.255.255.255`), wipes the MAC, and replies `wake.sent { wakeId, ok: boolean, error?: string (<= 200) }`; `ok: false` → `failed { cause: 'waker_error' }` |
| 8.2c | **MAC handling (W33).** The device reports its wake NIC's MAC as `wakeMac` (12 lower-case hex) in the enroll request, `device.hello` and `device.heartbeat`, over TLS. The server never stores it in plaintext: `device.mac_enc` = XChaCha20-Poly1305 under the region's fleet data key (`FLEET_DATA_KEY`, 32 bytes, env/secret store, stored with a key-id prefix so it can rotate) and `device.mac_hash` = HMAC-SHA256 under a subkey derived from the same key (an unkeyed hash of a 48-bit MAC would be brute-forceable), for de-duplication. For a wake the server decrypts the target MAC in memory, seals it to the elected waker's `kex_public_key` (`sealToDevice`, purpose `wake-mac`) and forgets it. `wakeMac`, `macEnc` and `targetMacSealed` are redacted from every log (§14). Honest scope: the server can read MACs (it must, to route a wake); what is protected is the database at rest, the logs and the other devices — a waker learns only the one MAC it was asked to wake, and no org-wide key exists on any device |
| 8.2d | The waker role is opt-in per org (`org.waker_mesh_enabled`, default true, `PATCH /orgs/current/policy/fleet`) and per device (`wakerOptOut` in the device's `config.json`, reported by omitting `waker` from `capabilities.features`); a segment with no eligible online waker returns `failed { cause: 'no_waker' }` and the console suggests AMT or asking someone to turn the machine on |
| 8.2e | A waker only ever sends a magic packet; it receives no other authority over its peers. The server chains each dispatch as `device.wake_dispatched { deviceId, wakeId, viaDeviceId }` (actor system, written when it pushes `wake.send`) so the mesh is on the record |

### 8.3 Wake sequence (end to end, WoL path)

| Step | Who | Action |
|---|---|---|
| 1 | Assist | `POST /devices/:id/wake { method: 'auto', reason? }` → `202 { wakeId, method: 'wol', via: <wakerDeviceId> }` after the server elects a waker |
| 2 | server | writes `wake_attempt` (`pending`) and `device.wake_requested`; elects a waker in the target's `lan_segment` (rule 8.2b); pushes `wake.send { wakeId, targetMacSealed }` to it (routed by node, rule 3.6c); state → `dispatched`, `device.wake_dispatched { deviceId, wakeId, viaDeviceId }` |
| 3 | waker | opens `targetMacSealed`, broadcasts the magic packet, replies `wake.sent { wakeId, ok: true }` |
| 4 | target | powers on, the service boots, `device.hello`s within `wakeConfirmSec` (120) |
| 5 | server | matches the reconnect to `wakeId`, marks `woke`, writes `device.woke { deviceId, wakeId, method: 'wol', via, elapsedMs }`, pushes `device.woke` to the requesting user's consoles |
| — | failure | no eligible waker → `202` is still returned with `via: null` and the attempt immediately `failed { cause: 'no_waker' }`; no reconnect in the window → `failed { cause: 'no_confirm' }`; each writes `device.wake_failed` and pushes it; both are shown honestly (P8) |

### 8.4 AMT / vPro power-on, SOL and boot redirect (self-hosted, hardware gated, v1)

| # | Rule |
|---|---|
| 8.4a | `AmtInventory` (reported at enrollment and heartbeat) `= { present: boolean, provisioned: boolean, version?: string, host?: string (the AMT firmware's own IP/FQDN), tls: boolean, powerState?: int }`. `present` = the firmware exists; `provisioned` = it has been set up for our management (admin credentials in the vault, rule 8.4c). The fleet view shows "Cold power on: available" only when `present && provisioned` **and** an AMT proxy exists for the device (PRD 15.3, P8) |
| 8.4b | **AMT proxy.** Commands run through `ia-waker`'s AMT client (`ia_waker::amt`) on an online P4 device in the target's segment that advertises the `amt_proxy` feature (it has verified it can reach AMT hosts on 16993/TLS or 16992); the server elects it like a waker (rule 8.2b). A deployment may instead run a dedicated in-region **AMT gateway** (`services/amt`, optional, not built here — a hook speaking the same messages). Messages (`schemas/signal-device.ts`): S→D `amt.command { cmdId, targetDeviceId, amtHost, tls, op: AMT_OPS, args: { target?: AMT_BOOT_TARGETS }, credSealed: Sealed }` with `AMT_OPS = ['power_on', 'boot_redirect', 'sol_open', 'sol_close']` and `AMT_BOOT_TARGETS = ['pxe', 'hdd', 'cd']`; D→S `amt.result { cmdId, ok, error?: 'amt_unreachable' \| 'auth_failed' \| 'unsupported' \| 'tls_failed', powerState?: int }`; D→S `amt.sol.data { cmdId, seq, data: base64url (<= 16 KiB) }`. The server relays SOL bytes to the opener's consoles on `/signal` as S→A `amt.sol.data { solId, seq, data }`; the console pane is **read-only** (no input path from Assist to the proxy exists). No Intel cloud dependency (PRD 15.3) |
| 8.4c | **Credentials.** AMT admin credentials are **never** stored on a device, in a device row or in a log; they live in the credential vault (§9.8, path `amt/<deviceId>` falling back to `amt/default` of the org). For each command the api reads the credential and seals it to the proxy's `kex_public_key` (purpose `amt-cred`); the proxy uses it for that one command and wipes it. TLS to AMT (16993) verifies the firmware certificate; plain HTTP AMT (16992) is allowed only when `amt.tls` is false and is flagged in the residency report (`amtPlainHttpDevices`) |
| 8.4d | **Gates and records.** Power-on is a wake (`POST /wake`, wake RBAC), chained `device.amt_poweron { deviceId, wakeId, viaDeviceId }` (actor system, at dispatch). The **SOL console** (`POST /devices/:id/amt/sol`) and **boot redirect** (`POST /devices/:id/amt/boot`) are out-of-band access where no on-screen indicator can exist, so they need senior_technician or org_admin (§7.1), a typed reason, and the policy flags `allowAmtSol` / `allowAmtBootRedirect` (default **false**). SOL sessions end after `LIMITS.amtSolMaxMinutes` (30) or on close; the server stores the SOL transcript in the object store and chains `device.amt_sol_closed { deviceId, solId, durationMs, transcriptSha256 }`; boot redirect chains `device.amt_boot_redirected { deviceId, cmdId, target, viaDeviceId, reason }`. Both appear in the device's receipts (§6.4) and in the "while you were away" toast of the next logged-on user |
| 8.4e | Hardware/firmware variance is wide; `ia_waker::amt` targets AMT ≥ 11 over the standard WS-Management (`/wsman`) interface; unprovisioned or unreachable firmware returns `failed { cause: 'amt_unreachable' }` (or `409 amt_unavailable` when no proxy exists) and the UI stays honest (P8) |

---

## 9. Device actions and the offline action queue (PRD 12.12)

| # | Rule |
|---|---|
| 9.1 | `POST /devices/:id/actions { kind, payload, reason? }` queues an action for a device. `DEVICE_ACTION_KINDS = ['playbook_run', 'file_push', 'print', 'message']`. Rule 9.9 decides whether it may run. If the device is **online** and the gate allows dispatch, the server dispatches at once over the device socket (`device.action { actionId, kind, payload, reason, technician: { name }, secrets? }`, S→D); if **offline** it is stored `queued` and delivered in `device.hello.ok.queued` on next check-in (§3.4), or pushed if the device comes online meanwhile |
| 9.2 | Table `device_action` (§13.2): `id`, `org_id`, `device_id`, `created_by`, `kind`, `payload jsonb`, `state` (`DEVICE_ACTION_STATES = ['queued', 'dispatched', 'awaiting_approval', 'running', 'done', 'failed', 'cancelled', 'expired']`), `reason`, `approved_by` (`'policy' \| 'local_user' \| 'auto_after_timeout'`, null until it runs), `result jsonb`, `expires_at` (default now + `LIMITS.deviceActionTtlDays` = 7 days), `dispatched_at`, `completed_at`, timestamps. An action older than `expires_at` is swept to `expired` |
| 9.3 | `playbook_run` payload = `{ playbookId, args, requiresElevation }` validated exactly as C §8 (the body is pinned and delivered the same way; the device verifies the hash against the manifest in `device.hello.ok.playbooks`, refreshed on each hello). `reason` is required when `requiresElevation` is true or the playbook declares `vaultRefs` (§9.8). Privileged runs are gated by rule 9.9 |
| 9.4 | `file_push` payload = `{ fileRef, name, bytes, sha256 }` where `fileRef` is a short-lived object-store presign (A §9, MinIO/S3); the device streams it to `%ProgramData%\IndiansAssist\pushes\` with MOTW (C §6.1 F3 rules) and reports `done` with the written path; it is **never** auto-executed (C §6.1 F4) |
| 9.5 | `print` payload = `{ fileRef, name, printer?: string }` (PRD remote printing): the device fetches the document and prints it to the named or default printer via the OS print spooler through a signed built-in playbook (`__ia_print`), reporting pages/exit; naming a non-default `printer` (or any driver action) counts as privileged under rule 9.9 and needs a `reason` |
| 9.6 | `message` payload = `{ title, body }` shows a toast/notification to whoever is at the device (useful for "we will connect shortly"); it never executes anything, so rule 9.9 does not gate it, but it is chained and receipted like every action |
| 9.7 | **Reporting and audit.** The device reports transitions with `device.action_result { actionId, state: 'awaiting_approval' \| 'running' \| 'done' \| 'failed', approvedBy?, result?, sig }` (D→S; `sig` by the identity key, domain `ia-action-v1`, §3.8; validated before use). The chain gets `device.action_queued` (user, at `POST`), `device.action_dispatched { actionId, deviceId, kind }` (system, at push), `device.action_started { actionId, deviceId, kind, approvedBy }` (device, on `running`), and `device.action_completed { actionId, deviceId, kind, state, exit?, ranAs? }` (device, on `done`/`failed`); `awaiting_approval` updates the row only. Output content of a `playbook_run` is never chained (C §8.5); only exit/duration/ranAs. Each finished action produces a receipt (§6.4) |
| 9.8 | **Vault secret injection (PRD 7 "injection rather than exposure", W37).** The api holds the only vault credential (AppRole, env `VAULT_ADDR`, `VAULT_ROLE_ID`, `VAULT_SECRET_ID`; a read-only vault policy on `secret/data/ia/<orgId>/*`). A playbook catalog entry may declare `vaultRefs: { env: /^[A-Z_][A-Z0-9_]{0,63}$/, path: string (<= 256, relative to the org prefix) }[]` (<= 8; `agent/playbook.ts` gains this optional field, set only by org_admin as for any playbook, §16.2). Such playbooks run **only as device actions**; an in-session `playbook.run` for one answers `not_allowed` and the console queues a device action instead. At **dispatch** (never at queue time, so secrets never rest in the queue) the api reads each path, seals each value to the device's `kex_public_key` (purpose `vault-secret`) and attaches `secrets: [{ env, sealed }]` to `device.action`. The service (`ia-vault`) opens them only to place them in the child process environment, wipes them after spawn, masks any exact secret value in captured output before reporting, and never logs, stores or forwards them. Audit `secret.injected { actionId, deviceId, refs: [{ env, path }], reason }` (actor system, at dispatch). Vault unreachable → the action `failed { error: 'vault_unavailable' }`. AMT credentials use the same path (rule 8.4c). No device ever holds a vault credential |
| 9.9 | **Action policy gate and visibility (binding).** Actions outside a session are unattended access, so the device's effective policy (§6.1) governs them as it governs sessions. At `POST`: `mode = deny` → `409 unattended_denied` for every kind except `message`. At dispatch and again on the device before running (the device holds the current policy from `device.hello.ok` and the S→D `device.policy { policy }` push sent whenever the effective policy changes): outside `allowedHours` the server holds the action `queued` and dispatches it at the next window start (or it expires); a **privileged** action (`requiresElevation`, `vaultRefs`, or `print` to a named printer) also needs `allowPrivileged` (else `failed { error: 'policy' }`). Then, by presence (§3.4): `allow` with nobody present → runs (`approvedBy: 'policy'`); `allow` with a user present and approval not required → runs (`approvedBy: 'policy'`) with the toast below shown first; `allow` with a user present and `requireLocalApprovalWhenPresent` → the **action approval card** (no answer within `LIMITS.localApprovalTimeoutSec` and no `autoAllowAfterSec` → the action stays `awaiting_approval` until answered or expired) ("<technician> (<org>) wants to <run playbook X / save file Y / print Z>. Reason: <reason>. Allow / Decline", physical-input gated; `autoAllowAfterSec` applies); `approval_only` → the card is always required, and with nobody present the action waits in `awaiting_approval` until someone is present and answers, or it expires; Decline → `failed { error: 'declined' }`; a `deny` policy reached after queueing → `failed { error: 'policy' }`. **Visibility:** every action that runs (every kind, `message` included) shows a toast "IndiansAssist: <technician> ran <name>" to a present user (or at the next unlock/logon), and appears in the Remote activity viewer and the receipts of §6.4 |

---

## 10. Self-healing and tamper-alerting agent (PRD 12.13)

| # | Rule |
|---|---|
| 10.1 | **Watchdog.** `IndiansAssistWatchdog` (a second service) plus a **scheduled task** `IndiansAssist Watchdog` (`LocalSystem`, trigger: at startup + every 5 min) both check that `IndiansAssistAgent` is `RUNNING` and that its binary's Authenticode signature and sha256 match the installed manifest; if the service is stopped/disabled/missing they attempt one restart (or re-register from the preserved MSI cache) and record a local tamper event with a cause (`stopped`, `disabled`, `deleted`, `binary_changed`, `config_changed`, `watchdog_restarted`) |
| 10.2 | **Backfill + alert.** Local tamper events are buffered in `%ProgramData%\IndiansAssist\tamper.log`, each signed with the identity key (domain `ia-tamper-v1`, §3.8) so a non-admin cannot forge one. The service sends them as `device.tamper { events: TamperEvent[] }` (D→S) right after `device.hello.ok` and whenever a new event is recorded while connected; the server answers `device.tamper.ok { ids }` (S→D) and only acknowledged events are removed (never dropped otherwise, the B §3.7 outbox rule). For each event the server writes `tamper.alert { deviceId, eventId, cause, at, detail }` (actor device: the device attested it) and sets `device.tamper_state = 'alerted'`, so the fleet view flags the device red. A device that was online and goes **silent past its heartbeat grace with no disable, retire or deregister on record** is marked `tamper_state = 'suspected'` after `LIMITS.tamperSilentGraceSec` (900) and the server writes `tamper.suspected { deviceId, lastSeenAt, silentSec }` (actor system), so a killed agent is visible rather than an innocent "offline" (P7). `suspected` stays until an org_admin acknowledges it (or backfilled events turn it into `alerted`) |
| 10.3 | **Integrity self-check.** On each start and every hour the service runs the C §2.6 `WinVerifyTrust` + `IA_EXPECTED_SIGNER` check on its own and the worker's binary and compares the import table against the KnownDLLs gate's expectation (C §11.3); a mismatch records a tamper event with cause `binary_changed` and refuses to spawn the worker until repaired |
| 10.4 | **Config and key protection.** The key blobs, config and manifest live under `%ProgramData%\IndiansAssist\` with `SYSTEM`+`Administrators` ACLs and a high mandatory label (§3.3); a change to config or manifest hash records `config_changed`. These are speed bumps against a local admin (who can, by definition, stop a service they own); the value is **visibility** — every such change is on the tamper-evident chain and in the fleet view, which is the PRD's claim (an attacker can disable the agent, but not silently) |
| 10.5 | `TamperEvent = { id: uuid, cause: TAMPER_CAUSES, at: ISO, detail?: string (<= 500), sig: base64url(64) }` with `TAMPER_CAUSES = ['stopped', 'disabled', 'deleted', 'binary_changed', 'config_changed', 'watchdog_restarted']` (device-recorded causes only; the server-derived suspicion is the separate `tamper.suspected` action and the `suspected` state). `TAMPER_STATES = ['ok', 'alerted', 'suspected']`; the fleet view's device badge reads `device.tamper_state`, with an acknowledge action (`POST /devices/:id/tamper/acknowledge`, org_admin, chained `tamper.acknowledged`, state → `ok`) |

---

## 11. Service architecture and build (Rust)

### 11.1 New crates (extend C §11.1)

| Crate | Owns | Depends on | Platform |
|---|---|---|---|
| `ia-service` | the SCM binary: identity and sealing keys (key gen, DPAPI seal/unseal, `deviceSigningInput` signing, §3.8), enrollment client, persistent `/signal/device` socket + device-auth, interactive-state reporting, the action policy gate (rule 9.9) and approval cards via the worker/UI, worker supervision + the §4.2 handoff pipe (incl. `sign_sas`), offline-queue drain, waker/AMT command execution, receipts store and "while you were away" toast (§6.4), watchdog registration, `SESSIONCHANGE` handling and desktop selection | `windows`, `windows-service`, `ia-core`, `ia-platform`, `tokio`, `tokio-tungstenite`, `ed25519-dalek`, `x25519-dalek`/`chacha20poly1305`/`hkdf` (already in C), `zeroize` | windows (service) |
| `ia-session0` | `WTSQueryUserToken`, `CreateProcessAsUser`, desktop enumeration/switching (`OpenInputDesktop`/`SetThreadDesktop`), secure-desktop targeting, the service↔worker pipe protocol; pure name/DACL/desktop-selection logic is unit-tested, the Win32 behind `winapi` | `windows`, `ia-platform` | windows |
| `ia-waker` | magic-packet builder/sender, segment hashing (rule 8.2a), opening a `targetMacSealed` with the device sealing key (rule 8.2c), the AMT WS-Management client (`amt`) used when the device is an AMT proxy, SOL byte forwarding; the packet and segment math is pure and tested | `windows` (sockets), `ureq`/`hyper`+rustls (AMT WS-Man), `ia-core` (`seal`), `ia-platform` | windows (sockets portable; AMT portable) |
| `ia-vault` | the **injection** side only (rule 9.8): opens server-sealed secrets with the device sealing key, places them in a child process's environment, wipes them, masks their exact values in captured output; it holds **no** vault credential and makes no network call | `ia-core` (`seal`), `zeroize` | portable |
| `ia-desktop` | the P4 desktop worker = the Phase C `ia-agent` serve loop with the §4.3 seams; a thin `main.rs` that reads the handoff blob and runs the C loop | all C agent crates + `ia-session0` | windows |

`ia-platform` gains traits `ServiceHost`, `DesktopBridge`, `Waker`, `Amt`, `SecretInjector` so the Phase E macOS/Linux daemons fill the same seam.

### 11.2 Crates/tools added (licences in `docs/LICENSE-REGISTER.md`)

| Component | Licence | Use |
|---|---|---|
| `windows-service` | MIT OR Apache-2.0 | Windows SCM integration (`ia-service`, `ia-watchdog`) |
| `windows` crate (already in C) | MIT OR Apache-2.0 | WTS, desktop, DPAPI (`crypt32`), AMT sockets, SCM config |
| **WiX Toolset v5** (installed as the .NET global tool `wix`) | **Microsoft Reciprocal License (MS-RL)** — used only as an unmodified build tool to compile our `.wxs` into an MSI; no WiX source is copied into our code and nothing of WiX ships inside the MSI payload beyond the standard MSI/CustomAction runtime it emits | builds the signed MSI (`packaging/windows/`, §12.2); invoked in CI via `dotnet tool`; added to the licence register under "build tools, not shipped" |
| OpenBao (or HashiCorp Vault) | OpenBao: MPL-2.0 (run as an unmodified separate service over its HTTP API, nothing linked/copied) | credential vault for AMT creds and privileged-playbook secrets, read by the api only (rule 9.8); self-hosted service, same posture as Garage/Keycloak in the register |
| `nodemailer` (api) | MIT-0 | the `smtp` driver of the consent-receipt mailer (rule 6.4d) |

No new web dependency; the api's vault client is plain `fetch` against the OpenBao HTTP API (no new package). The AMT WS-Management XML is handled with `quick-xml` (MIT) if a parser is needed, added to the register if used.

### 11.3 Build, size, signing

The MSI payload bundles the signed `ia-service.exe`, `ia-desktop.exe` (the C `ia-agent` renamed for the install), `ia-watchdog.exe`, and the shared system-DLL late-binding of C §11.3 (the import-table KnownDLLs gate applies to all three binaries). CI targets `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc`, `cargo build --release --locked`, Authenticode SHA-256 + timestamp on every exe and on the MSI, and the C §11.3 size/import gates per exe. `docs/release.md` gains the P4 MSI build and signing steps. The service binaries are **not** self-deleting (they are installed, not portable); C §10 self-delete is disabled in the P4 build.

### 11.4 Threading / IPC

Each process keeps the C §11.4 model (one tokio multi-thread runtime; capture/encode on dedicated threads in the worker). The service↔worker pipe and the device `/signal` socket are on the service's runtime; the worker holds its own runtime and its own `/signal` socket (§4.2). No blocking Win32 call runs on a runtime worker.

---

## 12. Mass deployment (PRD 3, 4, 5)

### 12.1 Channels

| Channel | Binding |
|---|---|
| **MSI + GPO** | a single signed MSI (per arch) installs the service; an org-specific **MST transform** (or MSI property) carries the signed `enroll.iaconfig` so one base MSI serves every org; deployed by Group Policy Software Installation or a startup script. One transform serves the whole rollout because its enrollment token carries `maxDevices` (§2.1); the tokens page warns when `devicesEnrolled` nears `maxDevices` or the token nears expiry, and the org_admin issues a new token and transform for later waves |
| **Intune** | the same MSI wrapped as `.intunewin` (or the MSI directly), assigned to a device group; enrollment config passed as an install command-line property `IA_ENROLL=<base64url signed enroll.iaconfig>` |
| **Manual** | an org_admin downloads the branded MSI from the tokens/fleet page (carrying the transform) and runs it; used for pilots |
| **deb/rpm + Ansible, PKG + MDM** | **Phase E** (§1.2); the packaging layout leaves room (`packaging/{linux,macos}/`) but ships nothing in Phase D |

### 12.2 MSI build (`packaging/windows/`, WiX)

| Item | Rule |
|---|---|
| Tool | WiX v5 as a .NET global tool (`dotnet tool install --global wix`); CI runs `wix build` over `packaging/windows/IndiansAssist.wxs`; no WiX binaries are checked in or shipped |
| Install | per-machine (`ALLUSERS`), `%ProgramFiles%\IndiansAssist\`, registers the two services and the scheduled task, writes `config.json` and `enroll.iaconfig` from the `IA_ENROLL` property or the transform (`IA_ENROLL` is declared in `MsiHiddenProperties`, so it never appears in the MSI log, and it is not persisted to the registry), sets the ACLs of §3.3/§10.4 via a custom action that runs as `LocalSystem` at install |
| Branding | org name/logo in the ARP (Add/Remove Programs) entry and the install UI come from the transform; the installer never phones home during install — enrollment happens on first service start (§3.1) |
| Signing | the MSI and every embedded exe are Authenticode-signed in CI (same identity as C §2.6); `IA_EXPECTED_SIGNER` is compiled into the binaries and checked at runtime (§10.3) |
| Upgrade | a MajorUpgrade with `Schedule="afterInstallExecute"`; the device identity, key and config under `%ProgramData%` survive an upgrade (only `%ProgramFiles%` binaries are replaced); the service re-reads its manifest after upgrade |
| Uninstall | §4.1 (deregister, wipe key/config) |

### 12.3 `enroll.iaconfig` (signed)

A UTF-8 JSON file (`<= LIMITS.enrollConfigMaxBytes` = 16384) placed by the MSI next to `ia-service.exe` (or written from the `IA_ENROLL` property), strict shape, **signed** by the region's token-signing key (C §2.4 reused): `{ v: 1, apiOrigin, signalUrl (the region's `/signal/device` URL), region, token: "<enrollment compact token>", groupId: uuid \| null, kid, sig }`. It is the **single source of a new device's group**: `groupId` is fixed when `GET /api/v1/devices/enroll-config` (org_admin, §7.2) mints the file, covered by `sig`, and verified again by the server at enrollment (§3.2); the token itself carries no group. The service verifies `sig` against the compiled `IA_REGION_PUBKEYS` (C §2.4), sends the file verbatim as `enrollConfig` (§3.2), then shreds it and the cached `IA_ENROLL` value (§3.1 step 5).

---

## 13. Shared, DB, and console additions

### 13.1 Shared (`packages/shared`, name index)

Each name has exactly **one owning file** (the row it appears in); every other file imports it. New P4 enumerations live in a new `enums-p4.ts` that `enums.ts` re-exports (the `enums-p3.ts` pattern). Every change to an existing file is additive and is also listed in §16.2.

| File | Exports |
|---|---|
| `enums-p4.ts` (new; `export *` from `enums.ts`) | `UNATTENDED_MODES`, `DEVICE_PLATFORMS` (`windows`,`macos`,`linux`), `DEVICE_ACTION_KINDS`, `DEVICE_ACTION_STATES`, `TAMPER_CAUSES`, `TAMPER_STATES`, `WAKE_METHODS` (`wol`,`amt`,`auto`), `WAKE_STATES` (`pending`,`dispatched`,`woke`,`failed`), `WAKE_FAIL_CAUSES`, `INTERACTIVE_STATES`, `CONSENT_DECISIONS` (`auto_grant`,`local_approval`,`local_consent`), `APPROVED_BY` (`policy`,`local_user`,`auto_after_timeout`), `LOCK_CHANGE_CAUSES`, `SECURE_DESKTOP_SURFACES` (`logon`,`uac`,`lock`), `AMT_OPS`, `AMT_BOOT_TARGETS`, `SEAL_PURPOSES` (`wake-mac`,`amt-cred`,`vault-secret`), `DEVICE_SIG_DOMAINS` (the eight domains of §3.8), `SERVICE_FEATURES = [...AGENT_FEATURES, 'secure_desktop', 'service_input', 'waker', 'amt', 'amt_proxy', 'sas']` (`input_lock` and `privacy_screen` are already in `AGENT_FEATURES`: a C agent never advertises them, a P4 worker does) |
| `enums.ts` (existing, additive) | `ACTOR_TYPES` += `device`; `SESSION_END_REASONS` += `consent_required`, `policy_timeout`, `device_disabled`; `DEVICE_STATUSES` += `superseded`, `retired`, `deregistered`; `WS_CLOSE.deviceUnauthenticated = 4412`; `TOKEN_LIFETIMES.enrollment.maxDays` 30 → 180; the `LIMITS` additions below; `export * from './enums-p4.js'` |
| `enums-p3.ts` (existing, additive) | `NATIVE_TIERS = ['p3_portable', 'p4_installed']`, `isNativeTier(tier)`; `consentLevelFamily(tier)` returns `'p3'` for every native tier; `TOKEN_SOURCES` += `service` |
| `errors.ts` (existing, additive) | codes `device_offline`, `device_busy`, `nobody_present`, `unattended_denied`, `approval_required`, `outside_policy_window`, `recorder_required`, `prelogin_not_permitted`, `device_unauthenticated`, `device_disabled`, `device_bad_signature`, `invalid_enroll_config`, `invalid_group`, `capability_mismatch`, `amt_unavailable`, `vault_unavailable`, `policy_forbidden` (`consent_required` already exists) |
| `agent/control.ts` (existing, additive) | `AGENT_CONTROL_ARGS['os.sas']`, `MIN_LEVEL['os.sas'] = 'elevated'` (§5.4); `AGENT_CONTROL_EVENT_KINDS` += `device_attest`, schema `ev('device_attest', { gen, sig })` (rule 3.5b) |
| `agent/playbook.ts` (existing, additive) | playbook entry `vaultRefs?` (rule 9.8) |
| `fleet/device.ts` | `deviceSchema`/`Device` wire, `serviceCapabilitiesSchema`/`ServiceCapabilities`, `amtInventorySchema`/`AmtInventory`, `lanSegmentSchema`/`LanSegment`, `interactiveStateSchema`/`InteractiveState`, `deviceEnrollRequestSchema`, `deviceEnrollReplySchema`, `hwFingerprint` rules |
| `fleet/policy.ts` | `unattendedPolicySchema`/`UnattendedPolicy`, `unattendedPolicyPatchSchema`/`UnattendedPolicyPatch`, `resolveUnattendedPolicy`, `DEFAULT_UNATTENDED_POLICY`, `isWithinPolicyWindow(policy, now)`, `decideDeviceSession({ unattended, policy, interactive, now })` → `{ decision } \| { error }` (the §6.2 table, one implementation the api uses and the Rust parity fixture checks), `decideDeviceAction({ kind, privileged, policy, interactive, now })` (rule 9.9) |
| `fleet/actions.ts` | `deviceActionSchema`/`DeviceAction`, per-kind payload schemas (`playbookRunActionSchema`, `filePushActionSchema`, `printActionSchema`, `messageActionSchema`), `deviceActionResultSchema` (the `result` object only) |
| `fleet/wake.ts` | `wakeRequestSchema`, `wakeReplySchema`, `wakeAttemptSchema` |
| `fleet/tamper.ts` | `tamperEventSchema`/`TamperEvent` (imports `TAMPER_CAUSES`) |
| `fleet/receipt.ts` | `deviceReceiptSchema`/`DeviceReceipt`, `deviceActionReceiptSchema`/`DeviceActionReceipt` (§6.4) |
| `fleet/signing.ts` | `deviceSigningInput(domain, fields)` (conventions, §3.8) |
| `fleet/seal.ts` | `sealedSchema`/`Sealed` (`{ epk, nonce, ct }`, base64url), `sealToDevice(kexPublicKey, deviceId, purpose, plaintext)`, `openSealed` (used by tests; the device opens in Rust) |
| `schemas/signal-device.ts` | the `/signal/device` unions. S→D: `deviceChallengeSchema`, `deviceHelloOkSchema`, `deviceSessionOpenSchema`, `deviceWorkerCredentialSchema`, `deviceActionMsgSchema` (`device.action`), `devicePolicySchema`, `deviceReceiptMsgSchema`, `deviceTamperOkSchema`, `deviceRotateOkSchema`, `wakeSendSchema`, `amtCommandSchema`. D→S: `deviceHelloSchema`, `deviceHeartbeatSchema`, `deviceInteractiveSchema`, `deviceWorkerCredentialRequestSchema`, `deviceActionResultMsgSchema` (`device.action_result`), `deviceTamperSchema` (`device.tamper`), `deviceRotateSchema`, `wakeSentSchema`, `amtResultSchema`, `amtSolDataSchema`. The A `error` message is reused. S→A on `/signal`, joined into the existing server union in `signal.ts`: `deviceWokeSchema`, `deviceWakeFailedSchema`, `amtSolDataAssistSchema` |
| `schemas/signal-messages.ts` (existing, additive) | `deskHelloSchema`: `token` optional, `workerCredential?`, exactly one of the two, `handover` only beside `token` (§4.2); `sessionCreatedSchema` += `device?: { id, name, keyId, publicKey }`, `unattended?: boolean` (P4 only) |
| `schemas/rest-fleet.ts` | all §7.2 request/response schemas; `SessionSummary`; residency extension |
| `schemas/rest-core.ts` (existing, additive) | `userSchema` += `deviceGroupIds?: uuid[] \| null`; `orgSchema` += `fleetScopingEnabled?: boolean`, `wakerMeshEnabled?: boolean`; the C agent policy is unchanged |
| `schemas/rest-tokens.ts` (existing, additive) | `createTokenRequestSchema` += `maxDevices?` (1..`LIMITS.enrollMaxDevices`, only with `typ = enrollment`); the token wire object += `maxDevices`, `devicesEnrolled` (enrollment tokens only) |
| `audit/actions.ts` (existing, additive) | the `session.knock` and `session.accepted` chain schemas become unions with their P4 branches (§13.3) |
| `audit/actions-p3.ts` (existing, additive) | `elevation.granted` += `mode?: 'handover' \| 'service'`; `sec.verified` += `method?: 'read_out' \| 'device_key'` |
| `audit/actions-p4.ts` (new) | every §13.3 action in `AUDIT_ACTIONS` with its chain schema; the P4 `desk.event` wire branches (`capture.secure_desktop`, `input.lock_changed`, `privacy.screen_changed`, `input.sas_sent`, `session.local_user_arrived`) joined into `deskEventDataSchema` |

`LIMITS` additions: `workerCredentialTtlSec: 120`, `enrollMaxDevices: 10000`, `deviceDisabledRetrySec: 3600`, `deviceQueueDrainMax: 100`, `wakeConfirmSec: 120`, `tamperSilentGraceSec: 900`, `enrollConfigMaxBytes: 16384`, `deviceActionTtlDays: 7`, `deviceActionOutputMaxBytes: 1048576`, `maxUnattendedMinutesCap: 1440`, `localApprovalTimeoutSec: 60`, `receiptDigestMinutes: 60`, `amtSolMaxMinutes: 30`, `deviceTagsMax: 32`, `deviceGroupsPerOrgMax: 500`, `fleetPageMax: 200`.

### 13.1a Key wire objects (binding field tables)

**`Device`** (REST, `fleet/device.ts`; the list/detail object the fleet console renders):

| Field | Type | Rule |
|---|---|---|
| `id` | uuid | device id |
| `name` | string (<=80) | machine name, sanitised |
| `platform` | `DevicePlatform` | `windows` in Phase D |
| `status` | `DeviceStatus` | `enrolled` \| `disabled` \| `superseded` \| `retired` \| `deregistered` |
| `online` | boolean | folded from presence (`ia:dev:<id>`), not a column |
| `keyId` | string (16 hex) | `kidOf(public_key)`; the public keys are not in this object (a P4 `session.created` carries the identity public key for rule 3.5b) |
| `osVersion` / `arch` / `agentVersion` / `serviceVersion` | string \| null | reported facts, updated each `device.hello` |
| `groupId` | uuid \| null | the device's group (null = org default policy) |
| `tags` | string[] (<= `deviceTagsMax`) | each sanitised, <= 40 |
| `capabilities` | `ServiceCapabilities` | below |
| `interactive` | `InteractiveState` \| null | last reported presence (§3.4) |
| `amt` | `AmtInventory` \| null | `null` when `present` is false or never reported |
| `tamperState` | `TamperState` | `ok` \| `alerted` \| `suspected` |
| `lanSegmentHash` | hex \| null | `lan_segment.subnetHash`; raw CIDR/MAC never exposed |
| `notifyEmail` | string \| null | receipt / tamper address set on the device (the effective address falls back to the group's, rule 6.4c) |
| `lastSeenAt` / `firstSeenAt` / `enrolledAt` | ISO \| null | |
| `lastIp` | string \| null | operational; in residency scope, org_admin/auditor only |

**`ServiceCapabilities`** (`serviceCapabilitiesSchema`, strict; superset of C `AgentCapabilities`):

| Field | Rule |
|---|---|
| `monitors` | int `1..16` |
| `elevation` | `'admin'` always (the service is `LocalSystem`); privileged mode is level, not integrity (§5.2) |
| `features` | unique values of `SERVICE_FEATURES` (C `AGENT_FEATURES` plus `secure_desktop`, `service_input`, `waker`, `amt`, `amt_proxy`, `sas`; a P4 device also advertises the existing `input_lock`, `privacy_screen` and `recorder`); the console greys a control whose feature is absent |
| `encoders` / `hwEncoder` / `interpreters` | as C §3.1 |
| `serviceVersion` | the installed service version (may differ from the desktop worker's `agentVersion` across an upgrade) |

**`AmtInventory`** (`amtInventorySchema`): `{ present: boolean, provisioned: boolean, version?: string (<=32), host?: string (<=255), tls: boolean, powerState?: int }` — reported at enrollment and heartbeat; rule 8.4a decides when the fleet view shows "Cold power on: available".

**`LanSegment`** (`lanSegmentSchema`): `{ subnetHash: hex64, gatewayMacHash: hex64, dhcpDomain?: string (<=255) }` — org-salted hashes computed on the device (rule 8.2a) so raw addresses never travel; devices sharing `subnetHash` form a waker segment.

**`DeviceAction`** (REST + `device.action` push): `{ id: uuid, deviceId: uuid, kind: DeviceActionKind, payload: <per-kind, §9>, state: DeviceActionState, reason: string \| null, approvedBy: ApprovedBy \| null, result: { exit?: int, ranAs?: 'user'\|'admin', pages?: int, path?: string, error?: string } \| null, createdBy: { id, name }, createdAt, dispatchedAt \| null, completedAt \| null, expiresAt }`. `state` runs `queued → dispatched → (awaiting_approval →) running → done\|failed`, or `cancelled`/`expired`; the device reports transitions via `device.action_result` (rule 9.7). The `device.action` push adds `technician: { name }` and, for vault-backed playbooks, `secrets: [{ env, sealed: Sealed }]` (rule 9.8); `secrets` never appears in REST.

### 13.2 Database (`packages/db`, migration `0007_phase_d`)

| Change | Detail |
|---|---|
| pgEnum `actor_type` | add `device` (ALTER TYPE ADD VALUE) |
| pgEnum `device_status` | add `superseded`, `retired`, `deregistered` |
| pgEnum `session_end_reason` | add `consent_required`, `policy_timeout`, `device_disabled` |
| pgEnum `device_platform` | new (`windows`, `macos`, `linux`) |
| pgEnum `device_action_kind` | new (`playbook_run`, `file_push`, `print`, `message`) |
| pgEnum `device_action_state` | new (`queued`, `dispatched`, `awaiting_approval`, `running`, `done`, `failed`, `cancelled`, `expired`) |
| pgEnum `wake_method` | new (`wol`, `amt`, `auto`) |
| pgEnum `wake_state` | new (`pending`, `dispatched`, `woke`, `failed`) |
| pgEnum `tamper_state` | new (`ok`, `alerted`, `suspected`) |
| `token` | add `max_devices` int not null default 1 check `1..10000`, `devices_enrolled` int not null default 0 check `<= max_devices` (meaningful for `typ = 'enrollment'`; other types keep the defaults) |
| `device` (extend A's placeholder) | add `region` region not null, `platform` device_platform not null default `windows`, `key_id` text, `kex_public_key` text null (required by the api for every P4 row), `os_version` text, `agent_version` text, `service_version` text, `arch` text, `hw_fingerprint` char(64), `last_ip` text, `group_id` uuid null fk device_group, `unattended_policy` jsonb null (override, `UnattendedPolicyPatch`), `interactive` jsonb null, `lan_segment` jsonb null, `mac_enc` text null, `mac_hash` char(64) null, `amt` jsonb null, `tamper_state` tamper_state not null default `ok`, `notify_email` text null, `rotation_nonce` text null, `enrolled_at` timestamptz, `first_seen_at` timestamptz null; `public_key` and `enrolled_by_token_id` already exist; `group_name` is **deprecated** (kept, never written or read in P4, dropped later); index `(org_id, status)`, `(org_id, group_id)`, `(lan_segment->>subnetHash)` via a generated column or expression index, `(org_id, mac_hash)` |
| `device_group` | new: `id` pk, `org_id` fk org index, `name` text (1..80, sanitised), `description` text null, `default_policy` jsonb not null default `{}` (`UnattendedPolicyPatch`), `default_tags` text[] not null default `{}`, `notify_email` text null, `created_by` fk user, `created_at`/`updated_at`, unique `(org_id, name)` |
| `device_action` | new (rule 9.2), incl. `approved_by` text null |
| `wake_attempt` | new: `id` pk, `org_id` fk index, `device_id` fk, `created_by` fk user, `method` wake_method, `via` text null (deviceId of the waker or AMT proxy), `state` wake_state, `cause` text null, `reason` text null, `created_at`, `confirmed_at` null |
| `amt_sol` | new: `id` pk, `org_id` fk index, `device_id` fk, `opened_by` fk user, `via_device_id` uuid, `reason` text not null, `opened_at`, `closed_at` null, `transcript_ref` text null, `transcript_sha256` char(64) null |
| `session.token_id` | **drop NOT NULL**; add CHECK `(token_id IS NOT NULL OR device_id IS NOT NULL)`; the existing partial unique index `session_token_open_unique` is unchanged (NULLs never conflict in it) |
| `session.device_id` | uuid null fk device, index; set for P4 sessions |
| `session.unattended` | boolean null (P4 only) |
| `session.unattended_policy` | jsonb null (the effective policy snapshot at open) |
| `session_device_open_unique` | new partial unique index on `session(device_id) WHERE state <> 'ended' AND device_id IS NOT NULL` (rule 3.5a) |
| `playbook.vault_refs` | jsonb null (rule 9.8; `[{ env, path }]`, <= 8) |
| `user.device_group_ids` | uuid[] null (group scoping, §7.1) |
| `org.waker_mesh_enabled` | boolean not null default true |
| `org.fleet_scoping_enabled` | boolean not null default false (§7.1) |
| `org.unattended_policy` | jsonb not null default `DEFAULT_UNATTENDED_POLICY` |

Append-only triggers and the A §4.2 lock order are untouched; every new audit action goes through `insertAuditEntry`. Device rows are mutable (last-seen, versions, tamper state); the chain records every privileged event, not the row mutations.

### 13.3 Audit actions (`actions-p4.ts`, strict chain schemas)

Every action has exactly one actor. `device` = attested by a device signature; `system` = derived or dispatched by the server; `desk` = reported by the session's desktop worker; `user` = a technician or admin request.

| Action | Actor | Written on | Chain `data` |
|---|---|---|---|
| `device.enrolled` | system | `POST /devices/enroll` | `{ deviceId, tokenId, keyId, platform, groupId, devicesEnrolled, maxDevices }` |
| `device.superseded` | system | re-enroll (rule 3.7a) | `{ fromDeviceId, toDeviceId }` |
| `device.key_rotation_armed` | user | `POST /rotate-key` | `{ deviceId }` |
| `device.key_rotated` | device | `device.rotate` (both signatures verified) | `{ deviceId, fromKeyId, toKeyId }` |
| `device.updated` | user | `PATCH /devices/:id` | `{ deviceId, fields }` |
| `device.disabled` / `device.enabled` / `device.retired` | user | REST | `{ deviceId }` |
| `device.deregistered` | device | signed `POST /deregister` | `{ deviceId }` |
| `device.enroll_config_issued` | user | `GET /enroll-config` | `{ tokenId, groupId }` |
| `user.device_groups_changed` | user | `PUT /users/:id/device-groups` | `{ userId, groupIds: uuid[] \| null }` |
| `device_group.created` / `_updated` / `_deleted` | user | REST | `{ groupId, fields? }` |
| `org.policy_updated` | user | `PATCH /policy/unattended`, `/policy/fleet` | `{ fields }` (B schema reused unchanged) |
| `session.knock` (P4 branch) | system | `POST /devices/:id/sessions` | `{ deviceId, keyId }` |
| `session.accepted` (P4 branch) | user | `POST /devices/:id/sessions` | `{ deviceId, unattended, reason: string \| null, onBehalfOf: null }` |
| `session.unattended_started` | system | the unattended session reaches `active` | `{ approvedBy, policySnapshot, reason }` |
| `session.local_user_arrived` | desk | `desk.event` (rule 6.2a) | `{ decision: 'continue' \| 'ended', levelDroppedTo: 'view' \| null }` |
| `capture.secure_desktop` | desk | `desk.event` | `{ surface, durationMs }` |
| `input.lock_changed` | desk | `desk.event` | `{ locked, cause }` |
| `privacy.screen_changed` | desk | `desk.event` | `{ on, cause }` |
| `input.sas_sent` | desk | `desk.event` | `{}` |
| `session.protections_released` | system | the worker's socket drops while input lock or privacy screen was on (rule 5.4d) | `{ inputLock: boolean, privacyScreen: boolean }` |
| `consent.receipt_sent` | system | rule 6.4e | `{ sessionId \| null, actionIds, channel, toHash, delivered, cause? }` |
| `device.wake_requested` | user | `POST /wake` | `{ deviceId, wakeId, method, reason: string \| null }` |
| `device.wake_dispatched` | system | `wake.send` pushed | `{ deviceId, wakeId, viaDeviceId }` |
| `device.amt_poweron` | system | `amt.command power_on` pushed | `{ deviceId, wakeId, viaDeviceId }` |
| `device.woke` | system | target reconnected in the window | `{ deviceId, wakeId, method, via, elapsedMs }` |
| `device.wake_failed` | system | rule W3 | `{ deviceId, wakeId, method, cause }` |
| `device.amt_sol_opened` | user | `POST /amt/sol` | `{ deviceId, solId, viaDeviceId, reason }` |
| `device.amt_sol_closed` | system | close or timeout | `{ deviceId, solId, durationMs, transcriptSha256 }` |
| `device.amt_boot_redirected` | user | `POST /amt/boot` | `{ deviceId, cmdId, target, viaDeviceId, reason }` |
| `device.action_queued` | user | `POST /actions` | `{ actionId, deviceId, kind, reason: string \| null }` |
| `device.action_dispatched` | system | `device.action` pushed | `{ actionId, deviceId, kind }` |
| `device.action_cancelled` | user | `POST /actions/:id/cancel` | `{ actionId, deviceId, kind }` |
| `device.action_started` | device | `device.action_result { state: 'running' }` | `{ actionId, deviceId, kind, approvedBy }` |
| `device.action_completed` | device | `device.action_result { state: 'done' \| 'failed' }` | `{ actionId, deviceId, kind, state, exit?, ranAs? }` |
| `secret.injected` | system | dispatch of a vault-backed action (rule 9.8) | `{ actionId, deviceId, refs: [{ env, path }], reason }` |
| `tamper.alert` | device | `device.tamper` | `{ deviceId, eventId, cause, at, detail }` |
| `tamper.suspected` | system | silent past grace (rule 10.2) | `{ deviceId, lastSeenAt, silentSec }` |
| `tamper.acknowledged` | user | `POST /tamper/acknowledge` | `{ deviceId, cause: string \| null, note: string \| null }` |
| `sec.verified` (C, extended) | user | `POST /sessions/:id/events` | C shape + `method?: 'read_out' \| 'device_key'` (rule 3.5b) |
| `elevation.granted` (C, extended) | as C | as C | C shape + `mode?: 'handover' \| 'service'` (rule 5.2b) |

**Carriers (binding; there is no `device.event` message):**

| Events | Carrier | `session_id` |
|---|---|---|
| `capture.secure_desktop`, `input.lock_changed`, `privacy.screen_changed`, `input.sas_sent`, `session.local_user_arrived` | the desktop worker's `desk.event` on `/signal` (the C §3.8 outbox: never dropped, flushed before the socket closes) | set |
| `device.action_started`, `device.action_completed` | signed `device.action_result` on `/signal/device` | null |
| `tamper.alert` | signed `device.tamper` on `/signal/device`, acknowledged by `device.tamper.ok` | null |
| `device.key_rotated` | `device.rotate` on `/signal/device` | null |
| `device.deregistered` | signed `POST /devices/:id/deregister` | null |
| every other action | written by the api on the REST call or server event named in the table | the session's id where one exists, else null |

### 13.4 Console (`apps/web`)

| Page / component | Behaviour |
|---|---|
| `/app/fleet` | the **fleet console**: a filterable/sortable device table (name, group, tags, online dot, presence (`interactive`), last seen, OS/version, tamper badge with text, "Cold power on: available/not available", unattended mode); bulk tag/group/policy actions (org_admin); a group sidebar with per-group policy editor |
| `DeviceRow` / `DeviceDetail` | status, capabilities, effective policy, AMT inventory, recent sessions, offline queue with `awaiting_approval` shown as "waiting for someone at the device"; actions: **Connect** (attended / unattended choice; a required reason field for unattended → `POST /devices/:id/sessions`), **Wake** (method picker, optional reason, live state), **Run action** (playbook/file/print/message; reason required where rule 9.1 says), **Disable/Retire/Rotate key/Acknowledge tamper** (org_admin); a `409` from §6.2 is shown in plain words with the next step |
| `UnattendedPolicyEditor` | every §6.1 field with safe defaults, an "allowed hours" builder, and clear warnings on dangerous combinations (`allow` with `allowLogonScreen`, `allowSecureDesktop`, `allowPrivileged`, `allowAmtSol` or `allowAmtBootRedirect`: "this group can be entered with nobody present and the technician can see Windows sign-in and security screens"); audited on save |
| `AgentConsole` (P4) | the C §13.4 console, chosen by `isNativeTier(session.tier)`, plus: an **Unattended** banner ("No one is at this device — session is policy-authorised and recorded"), a "Someone is now at the device" banner when rule 6.2a fires, the **device-key verification** state in place of the read-out step for auto-granted sessions (rule 3.5b), **Input lock** / **Privacy screen** toggles (greyed unless `elevated` + policy; a pending local approval is shown), a **Send Ctrl+Alt+Del** button, a **Secure desktop** indicator (and a "hidden by policy" state), and the recording badge forced on when `recordingRequired` |
| `WakePanel` | method (`auto`/`wol`/`amt`), the resolved `via` (which waker / AMT proxy), live `pending → dispatched → woke/failed` with honest failure causes; **Open SOL console** and **Boot redirect** (senior_technician/org_admin, reason required, hidden when the policy flag is off) and a read-only **SOL console** pane |
| `DeviceGroupAdmin` | group CRUD, default policy, default tags, notify email, technician group assignment (`PUT /users/:id/device-groups`), and the fleet-scoping switch with an explanation that unassigned technicians lose fleet access when it is on |
| Tokens page | enrollment tokens show `devicesEnrolled / maxDevices` and expiry warnings; **Download MSI (enrollment)** per enrollment token + group selector (calls `GET /devices/enroll-config` and serves the branded MSI/transform), plus GPO/Intune copy-paste snippets of the same signed config |
| Residency page | fleet counts, wake attempts, unattended sessions, device actions, AMT-over-plain-HTTP flags |

The console reads the session level from `consent.changed` (C rule); "privileged mode" sets/reads `elevated`. The security-code gate follows rule 3.5b: the C read-out step for sessions a person approved, device-key attestation for auto-granted sessions, re-applied after every desktop-switch rebuild (§5.3).

### 13.5 Non-functional targets for the fleet (PRD 13)

| Area | Target and rule |
|---|---|
| Device connections | design target **100,000 connected devices per region cluster** and **20,000 per api node**, separate from the PRD's 10k concurrent sessions; a `/signal/device` socket is idle apart from a heartbeat every 30 s ±5 s (about 670 messages/s per full node) |
| Reconnect storms | after a node restart devices reconnect with C §3.1 backoff, ±30 % jitter and an initial random delay of 0..30 s; a node verifies at most `DEVICE_HELLO_RATE` (env, default 500/s) `device.hello`s and closes the excess with `4429` (`rateLimited`), which the service treats as backoff |
| Presence availability | presence is in redis with a 90 s TTL; when a node dies its devices reconnect to any node and presence re-forms within one backoff cycle; the 900 s tamper grace (rule 10.2) is far longer than this, so a node loss never marks devices `suspected`. Availability target for `/signal/device`: 99.9 % (PRD 13 signaling) |
| Session quality | P4 sessions inherit C's latency, ABR ladder and sub-300 kbps floor mode unchanged |
| Observability | `prom-client` metrics (already an api dependency): `ia_devices_connected`, `ia_device_hello_total{result}`, `ia_device_heartbeat_lag_seconds`, `ia_wake_attempts_total{method,result}`, `ia_device_actions_total{kind,state}`, `ia_tamper_alerts_total{cause}`, `ia_receipts_sent_total{channel,delivered}`; structured logs keyed by `deviceId` (never a MAC; IPs only as the operational `last_ip`); per-session traces as C |
| Load test | `smoke:p4:load` (`scripts/smoke-p4-load.mjs`, Node): 2,000 simulated devices on one node enroll, hello, heartbeat for 10 minutes, survive a forced node restart, and must all be back online within 2 minutes with no `tamper.suspected`; nightly CI, not per PR |
| Accessibility | `/app/fleet`, `DeviceDetail`, `UnattendedPolicyEditor`, `WakePanel` and the P4 `AgentConsole` additions meet WCAG 2.1 AA: fully keyboard-operable tables and dialogs, status never by colour alone (tamper and online badges carry text), wake state and arrival banners in polite live regions; asserted in the P4 Playwright specs with role-based locators and keyboard-only flows (no new dependency), contrast checked in the `docs/release.md` manual list |

---

## 14. Security

| Asset / surface | Threat | Mitigation |
|---|---|---|
| Device identity and sealing keys | a stolen disk/image impersonates the device or opens its sealed secrets | DPAPI machine scope + an ACL'd HKLM entropy blob binds both sealed keys to the machine (§3.3); a copied disk cannot unseal on another host; a re-image with a wiped key needs an enrollment token with capacity and supersedes the old row visibly (rule 3.7a); the keys never leave the device and are never logged; the identity key never enters the desktop worker (it asks the service to sign, §4.2) |
| Enrollment token | a leaked enrollment token enrolls rogue devices | the token only works inside a region-signed `enroll.iaconfig` (§12.3); it enrolls at most `maxDevices` devices (W30), lives 7 d by default (180 d max), is `p4_installed`+`enrollment` only and bound to its org/region/group; enrollment requires a device-key possession proof (`deviceKeyProof`); every enrollment is chained with `devicesEnrolled/maxDevices`; the org_admin sees devices appear, can revoke the token to stop further enrollments and can disable any device. Residual: a leaked config can enroll up to the remaining capacity, so admins size `maxDevices` to the rollout |
| Device auth replay | a captured `device.hello` is replayed | a fresh per-socket `serverChallenge` is signed each time (§3.4, §3.8); a disabled/retired/superseded/deregistered device is refused `4412`; the deregister call carries a timestamp and single-use nonce |
| Unattended abuse | a technician silently watches or acts on a machine nobody is at | the pill/tray/recording dot are mandatory and injection-proof (C §3.5, re-imposed by the service) and stay above the privacy overlay (rule 5.4b); every unattended start requires a typed reason and writes `session.unattended_started` with the policy snapshot; device actions are under the same policy (rule 9.9); `recordingRequired` default-on; a server-built receipt is stored on the device, shown to the next user and mailed to the notify address (§6.4); `mode` defaults to `approval_only` until an admin opts a group into `allow`; `requireLocalApprovalWhenPresent` and the arrival rule (6.2a) stop taking over an in-use machine |
| Privileged mode | capture of the secure desktop / input lock / privacy screen without cause | each is `elevated`-gated and per-capability policy-gated (default false), requested with a typed reason, approved locally whenever a user is present (rules 5.2b, 5.4c), chained (`elevation.requested`/`.granted`, `capture.secure_desktop`, `input.lock_changed`, `privacy.screen_changed`, `input.sas_sent`); input lock fails open to the user (Ctrl+Alt+Del always escapes) |
| Local attack surface | a local port/pipe another process abuses; a same-user process writes a file the service runs | the service opens no listening socket; the service↔worker pipe is `FIRST_PIPE_INSTANCE \| REJECT_REMOTE_CLIENTS` with a SYSTEM+worker-SID DACL and pid/image verification (§4.2); the worker credential is single-use, session-bound and delivered only over the device socket; playbook execution follows C §8 (stdin for PowerShell, admin-only HI-labelled dir for cmd, hash re-check before resume); config/keys/manifest are SYSTEM+Administrators, high mandatory label (§3.3, §10.4) |
| MAC/address leakage | the fleet DB leaks device MACs/IPs | MACs are stored encrypted at rest under the region fleet data key with a keyed de-dup hash (rule 8.2c); a wake target's MAC is sealed to the one elected waker; no org-wide key exists on devices; LAN segments are org-salted hashes, not raw CIDRs; `last_ip` is operational and in the residency scope (W33) |
| AMT credentials and out-of-band access | powerful out-of-band creds on a device; a pre-boot console nobody can see | AMT admin creds live only in the vault, read by the api and sealed to the AMT proxy for one command, never on a device row or in a log (rule 8.4c); SOL and boot redirect are off by default, senior/org_admin only, reason-required, chained with a hashed SOL transcript, and reported to the next user and the notify address (rule 8.4d); plain-HTTP AMT is flagged in residency |
| Vault secrets | a playbook secret leaks to a technician, a log or the queue | the api holds the only vault credential; secrets are fetched at dispatch, sealed to the one target device, injected into the child environment, masked in captured output and never stored or shown (rule 9.8); every injection is chained (`secret.injected`) |
| Waker mesh misuse | a compromised device wakes/attacks peers | a waker's only power is emitting a magic packet for one target it is handed; it gains no session authority; `wake.send` is server-driven and chained (`device.wake_dispatched`); the mesh is opt-in per org/device |
| Tamper / silent kill | an attacker disables the agent to hide activity | the watchdog (service + scheduled task) restarts/alerts; local tamper events are device-key-signed, acknowledged, backfilled and chained (`tamper.alert`); a silent-past-grace device is chained `tamper.suspected`; integrity self-check refuses to spawn a modified worker; the honest claim is visibility, not prevention (P7, §10) |
| Secure channel / MITM | the signaling server rewrites fingerprints | unchanged from C §1.3 (commit round, SAS, fingerprint binding, per-key-generation control gate) for sessions a person approved; auto-granted sessions use device-key attestation (rule 3.5b), which binds the keys to the enrolled device but trusts the region server's copy of the device key, and is chained distinctly; every desktop-switch rebuild re-verifies |
| Data residency | fleet/wake/AMT data leaving the region | device rows, groups, actions, wake attempts, SOL transcripts, receipts and audit stay in the org's region (A T1); the device connects to the region origin; the waker mesh and AMT act within the device's own LAN; the residency report lists device counts and any plain-HTTP AMT |

The pino `REDACT_PATHS` (`apps/api/src/lib/logger.ts`) gains `'*.privkey'`, `'*.macEnc'`, `'*.wakeMac'`, `'*.targetMacSealed'`, `'*.credSealed'`, `'*.secrets'`, `'*.sealed'`, `'*.workerCredential'`, `'*.deviceKeyProof'`, `'*.enrollConfig'`, `'*.secret'`, `'*.vaultToken'`, `'*.serverChallenge'`; `device.key`, `device.kex`, `config.json`, the AMT creds, vault secrets and `FLEET_DATA_KEY` are never logged. The service's `tracing` redaction mirrors C §6.

---

## 15. Tests and gates

### 15.1 Shared (vitest)

`test/fleet-policy.test.ts` (`resolveUnattendedPolicy` org/group/device merge with strict re-validation, `isWithinPolicyWindow` across the tz boundary, `decideDeviceSession` over every row of the §6.2 table, `decideDeviceAction` over rule 9.9, defaults safe), `test/fleet-schemas.test.ts` (device/group/action/wake/tamper/receipt schemas, `InteractiveState`, `deviceEnrollRequest/Reply`, the `/signal/device` messages, `serviceCapabilities` incl. no duplicate `SERVICE_FEATURES`, `amtInventory`, `lanSegment`), `test/fleet-signing.test.ts` (`deviceSigningInput` against `fixtures/fleet/signatures.json` for all eight §3.8 domains; `sealToDevice`/`openSealed` round-trip and vectors), `test/fleet-actions.test.ts` (per-kind payloads, reason-required rules, the `playbook_run` reuse of C's arg validation, `vaultRefs` validation), extended `test/signal-schemas.test.ts` (the `/signal/device` unions; `desk.hello` with exactly one of `token`/`workerCredential`; P4 `session.created`), `test/enums-p4.test.ts` (`isNativeTier`, `consentLevelFamily('p4_installed') === 'p3'`, the additive enum values of §16.2), `test/audit-p4.test.ts` (every §13.3 action wire-vs-chain, one actor each; the P4 branches of `session.knock`/`session.accepted`; `elevation.granted.mode`, `sec.verified.method`). The agent name/fixture parity check (C §15.1) is extended with `fleet/*` fixtures and `os.sas` / `device_attest`.

### 15.2 Service / worker (Rust, `cargo test`)

Pure, portable: identity and sealing key gen, `deviceSigningInput` + sign/verify against the shared vectors, `openSealed` against the shared vectors, the §6.2/§9.9 decision parity with the TS fixture, `resolveUnattendedPolicy` parity, the enrollment client state machine (incl. `410 token_used` and `429` backoff), the offline-queue drain ordering and `awaiting_approval` handling, the tamper outbox (ack removes, no ack keeps), the magic-packet builder (bytes against a vector), segment hashing against a vector, the AMT WS-Man request builder (XML against a vector), the handoff-blob codec, secret masking in captured output, the DPAPI seal/unseal round-trip behind a trait mock. `#[cfg(windows)]`: the DACL/pipe-name derivation for the service↔worker pipe (reusing the C §7.2 pid/image checks against a fake peer), desktop-selection logic and `InteractiveState` derivation against a mock `WTS`/desktop table, the watchdog detect-and-restart decision table, the DPAPI machine-scope seal on the real host (gated, skipped on a non-Windows runner). The `ia-desktop` worker reuses the C loopback test; a new loopback test drives the §4.2 handoff (service writes a blob, worker presents its worker credential and reaches `active`, then a `sign_sas` round trip). No test calls `CreateProcessAsUser`, `SendSAS`, `BlockInput`, a real AMT host, or `ShellExecuteExW` (no privileged side effects in CI); those paths are exercised behind traits with mocks and documented as manual-check steps in `docs/release.md`.

### 15.3 API / web (vitest, Playwright)

api: `test/enroll.test.ts` (iaconfig signature, token verify, `maxDevices` race → exactly K devices then `410 token_used`, `deviceKeyProof` check, group from the signed iaconfig only, region binding, rate limits), `test/device-signal.test.ts` (`/signal/device` upgrade with and without `Origin`, challenge/hello/auth, bad signature → 4412, disabled → 4412, `assist.hello` on it → 4403, heartbeat and `device.interactive` presence, queued drain on hello, that no device frame is ever sent on `/signal`), `test/worker-credential.test.ts` (delivery only on the device socket, single use, expiry, capability subset, adoption after reconnect), `test/devices.test.ts` (fleet RBAC incl. fleet scoping on/off with null/empty groups and cross-org 404, PATCH, disable/enable/retire/rotate/deregister, `session open` over every §6.2 outcome incl. `device_busy` and `prelogin_not_permitted`, reason required for unattended, residency counts), `test/native-tier.test.ts` (a P4 session takes the P3 consent, events, recording, playbook and manifest paths: every branch listed in §16.2), `test/wake.test.ts` (waker election in a segment, `no_waker`/`no_confirm`/`amt_unavailable`/`amt_unreachable` honest states with `device.wake_failed`, MAC never stored or logged in plaintext, sealed to the waker, wake audit chain), `test/amt.test.ts` (SOL/boot RBAC, policy flags, reason, transcript hash chained), `test/offline-queue.test.ts` (queue-then-deliver on reconnect, policy gate per rule 9.9 incl. `deny` at POST and `awaiting_approval`, `allowedHours` hold, expiry sweep, per-kind validation, signed result chaining), `test/vault.test.ts` (secrets fetched at dispatch only, sealed to the device, `secret.injected` chained, `vault_unavailable`), `test/receipts.test.ts` (receipt built from the chain, notify-address fallback, `consent.receipt_sent` for each channel incl. `no_mailer`), `test/tamper.test.ts` (backfilled `device.tamper` → `tamper.alert` + ack, silent-past-grace → `tamper.suspected`, acknowledge). web: `/app/fleet`, `DeviceDetail`, `UnattendedPolicyEditor` (dangerous-combination warnings), `WakePanel` (incl. SOL/boot gating), `AgentConsole` P4 additions (chosen by `isNativeTier`, unattended banner, device-key verification state, arrival banner, input-lock/privacy toggles gated on `elevated`+policy, SAS button), tokens-page MSI download with `maxDevices`; keyboard-only and role-locator accessibility checks (§13.5). `smoke:p4` (`scripts/smoke-p4.mjs`, Node, no browser): a Node ws client simulates a device through enrollment (`POST /devices/enroll` with a signed iaconfig), `device.hello` with a signed challenge on `/signal/device`, `POST /devices/:id/sessions { unattended: true, reason }` reaching `active` with `session.unattended_started` chained and a valid `device_attest`, a queued `device.action` delivered on reconnect and its signed result chained, a `POST /wake` whose waker peer (a second simulated device) opens the sealed MAC and confirms, and a `device.tamper` producing `tamper.alert`. `smoke:p4:load` per §13.5.

### 15.4 Gates and definition of done

| Stream | Must pass |
|---|---|
| shared/db/api | `pnpm --filter @indiansassist/shared typecheck test`, `--filter @indiansassist/db typecheck test` (migration `0007_phase_d` applies on PGlite; new and extended enums, `device`/`device_group`/`device_action`/`wake_attempt`/`amt_sol` round-trip, a token-less P4 session row passes the CHECK and the device-open unique index rejects a second open session), `--filter @indiansassist/api typecheck test`; `pnpm smoke` 26/26, `smoke:p2`, `smoke:recorder` 12/12 + P3, `smoke:p3`, and new `smoke:p4` green (the existing smokes prove the additive changes of §16.2 broke nothing) |
| service | `cargo build`, `cargo test` (incl. the handoff loopback) and `cargo clippy -D warnings` green; `node scripts/license-check.mjs` passes with the new crates and WiX/OpenBao/nodemailer entries; **CI:** `cargo build --release --locked` both msvc targets, the import-table + size gates per exe, Authenticode on all three exes and the MSI, `wix build` produces a signed MSI, the `WinVerifyTrust` self-check runs |
| web | `pnpm --filter @indiansassist/web typecheck test build`; the P4 Playwright specs green |
| packaging/integration | the MSI installs/uninstalls cleanly in a Windows sandbox (manual-check in `docs/release.md`), `docs/LICENSE-REGISTER.md` lists every §11.2 entry (WiX as a non-shipped build tool, OpenBao as a separate service, nodemailer), `infra/.env.example` documents the new api env (§16.1), `pnpm validate:infra` green |

**Definition of done for Phase D:** a signed MSI deployed to several machines with one enrollment config enrolls each of them, each minting its own device identity and discarding the enrollment material; the devices appear online in the fleet console with their presence; an org_admin sets a group's unattended policy; a technician opens an **unattended** session with a typed reason (policy-authorised, recorded, pill visible, device-key verified, receipt produced, stored on the device and mailed) and, with privileged mode, captures the secure desktop, locks local input and sends Ctrl+Alt+Del; a user who then sits down sees the arrival card and can end the session; a sleeping device is woken over the LAN waker mesh and an AMT-capable device is powered on from off; an offline device runs a queued playbook and file push on next check-in under the action policy gate; stopping the service raises a `tamper.alert` visible in the fleet view; all gates above are green and the §16 PRD-deviation table is applied to `PRD.md`.

---

## 16. Open questions resolved and PRD deviations

| # | PRD / task text | Phase D position | Why |
|---|---|---|---|
| W28 | PRD 3/5 "installed as a system service ... boot time and pre-login access" | a `LocalSystem` service in session 0 **plus** a per-session `ia-desktop` worker launched onto the active (or secure/logon) desktop, over a hardened pipe (§1.4, §4); pre-login access is delivered but policy-gated (W42) | a session-0 service cannot capture or inject on a user/secure desktop; the worker must run in the target session; the worker reuses the Phase C agent unchanged |
| W29 | PRD 6 token flow applied to P4 | after enrollment the **device identity** is the credential for every session (attended or unattended); no per-session `one_time`/`timed` P4 token is minted; P4 sessions are token-less (`session.token_id` null, `device_id` set) | the device is always-connected and cryptographically identified; a fresh token per session would recreate the attended flow for a machine that is already trusted |
| W30 | PRD 6 "enrollment tokens that mint a long-lived device identity, then are discarded" | an enrollment token mints **up to `maxDevices`** device identities (default 1; counted under a row lock, `used` when exhausted), so one GPO/Intune rollout enrolls a fleet; each device shreds the enrollment material the moment it holds its own key pair and never presents the token again (§2.1, §3) | a single-mint token cannot serve one MSI transform pushed to many machines (PRD 3 mass deployment); "discarded" holds per device, and the bounded count plus revocation keep the token from being an unbounded standing credential |
| W31 | how the worker joins the already-open session without a new code path | the worker presents a single-use **worker credential** (32 bytes, 120 s) that the server hands the service over the authenticated device socket; `desk.hello` carries it instead of a token and the server registers the socket through the C §7.2 hand-over registration code | reuses the Phase C registration machinery; keeps `ia-agent` unchanged; no REST call needs device authentication |
| W32 | PRD 3 P3→P4 "elevation" vs a `LocalSystem` service | P4 "privileged mode" raises `session.consent_level` to `elevated` **in place**, with no UAC relaunch (the service is already `LocalSystem`); C §7 hand-over is not used in P4; a present user approves it locally | there is no higher integrity to hand over to; the elevation audit, reason and policy gate still apply |
| W33 | PRD 12.5 WoL needs the target MAC | MACs are stored **encrypted at rest under the region fleet data key** with a keyed de-dup hash; for a wake the server seals the one target MAC to the elected waker's sealing key; no org-wide key on devices; no plaintext MAC in a row or log | a fleet DB of plaintext MACs/IPs is a lateral-movement map; the earlier org-wide waker key would have let one compromised device read every MAC; the server must read MACs to route wakes, and says so |
| W34 | PRD 3 "Remote power on ... optional and hardware gated" vs decision 15.3 "ships in v1" | AMT power-on **ships in v1**, gated by `amt.present && amt.provisioned` and an available AMT proxy, surfaced as "available/not available"; SOL and boot redirect ship but are off by default and senior-only (§8.4); deeper AMT provisioning is deferred | decision 15.3 overrides the earlier "optional" wording; the gate keeps the UI honest (P8) |
| W35 | PRD 7 "require a one-time local approval window during enrollment" | the local approval is modelled per session by the policy's `approval_only` mode, `requireLocalApprovalWhenPresent` and `autoAllowAfterSec`; a session approved by a sitting user chains `approvedBy: 'local_user'`; device actions follow the same gate (rule 9.9) | a per-session policy decision is more precise than a single enrollment-time toggle and still satisfies the PRD |
| W36 | PRD 3/5 macOS `launchd` + Linux `systemd` "Package 4" | **deferred to Phase E**; the `ia-platform` traits leave the seam; Phase D binds Windows only | Windows is the first platform per PRD section 5 and the existing Phase C precedent |
| W37 | PRD 7/8 credential vault "OpenBao or Vault", "injection rather than exposure" | the **api** is the only vault client (AppRole); it fetches a secret at dispatch, seals it to the one target device, and the device's `ia-vault` injects it into a child environment and wipes it; no device holds a vault credential; every injection is chained (rule 9.8) | credential injection, not exposure; a vault credential on every device would be the exposure the PRD forbids |
| W38 | PRD 4 "Remote printing: Yes" (P4) | a `print` offline/online action and a signed `__ia_print` built-in playbook print a fetched document to the device's default/named printer, under the action policy gate | printing reuses the action/playbook machinery and the object store; no new transport |
| W39 | task: WiX for the MSI | the MSI is built with **WiX Toolset v5 installed as the .NET global tool** (`dotnet tool install --global wix`); WiX (MS-RL) is a non-shipped build tool and is recorded in the licence register | WiX is not installed on the build host but installs as a .NET tool; MS-RL is fine for an unmodified build tool we do not redistribute |
| W40 | PRD 14 lists the credential vault under **Phase E** | the vault integration (rule 9.8) is delivered in **Phase D** | AMT power-on is a v1 P4 feature (decision 15.3) and its admin credentials must live in the vault (rule 8.4c); privileged playbook secrets use the same path |
| W41 | Revision 1's "device bootstrap credential" returned by enrollment | **removed** | the first `device.hello` is already authenticated by the device-key signature over a fresh challenge; the bootstrap value proved nothing more and had an undefined expiry path; first contact is recorded as `device.first_seen_at` |
| W42 | PRD 3 "boot time and pre login access through the service" | delivered, but pre-login (logon screen) and secure-desktop capture are separate policy flags, both **off by default**; with them off a pre-login request answers `409 prelogin_not_permitted` (rule 5.1c) | safe by default (P4, P5): seeing the logon and security screens of a machine nobody is at is opted into per group by an org_admin, with a warning in the policy editor |
| W43 | PRD 7 "per group and per device scoping" | per-group scoping via `user.device_group_ids` under the org switch `fleet_scoping_enabled` (fail closed when on); **per-device scoping is a group of one device**, no separate per-device ACL | one scoping mechanism keeps RBAC checkable in one place; a group of one gives the same effect |
| W44 | (Revision 1) device auth on the existing Origin-less `/signal` socket | a separate upgrade path **`/signal/device`** for the service; `/signal` is unchanged | the server cannot tell a device from a C agent or recorder before hello, and must not send them an unknown `device.challenge` frame |
| W45 | C §1.3 step 7 security-code read-out applied to sessions with nobody present | auto-granted P4 sessions satisfy the gate by **device-key attestation** of the SAS and fingerprints, chained as `sec.verified { method: 'device_key' }`; sessions a person approved keep the read-out (rule 3.5b) | nobody can read a code aloud at an empty desk; the attestation binds the session keys to the enrolled device, and its weaker trust (the region server's copy of the device key) is recorded for auditors |

### 16.1 PRD and spec amendments to apply

- PRD 3 Package 4: AMT is a v1 feature with a hardware gate (already decision 15.3); the service shape is §1.4; the C §7.4/W9 deferrals (secure-desktop/lock-screen capture, service-grade input, input lock, privacy screen) are delivered here (§5); pre-login access is policy-gated (W42).
- PRD 6 enrollment: made concrete in §3; enrollment tokens mint up to `maxDevices` identities and each device discards the material (W30); the device identity is the standing credential (W29).
- PRD 7: per-device scoping as a group of one (W43); the one-time local approval is per-session policy (W35); vault injection is api-side (W37).
- PRD 11 `POST /devices/:id/wake` → §8.1; `POST /devices/:id/script` → `POST /devices/:id/actions { kind: 'playbook_run' }` and the online dispatch / offline queue (§9), with `POST /devices/:id/sessions` for live entry (W29).
- PRD 14: the credential vault moves from Phase E into Phase D (W40).
- A §2.1 `p4_installed` / `enrollment`: `desk.hello` with a token still answers `join_unsupported`; the service uses `device.*` on `/signal/device` (§3.4, W44); the desktop worker uses `desk.hello { workerCredential }` (§4.2). A §3.2: enrollment tokens become functional, gain `maxDevices` and a 180-day maximum.
- A §2.3 permission matrix gains the device/fleet rows (§7.1); A §4.2 data model: the device table is extended and `session.token_id` becomes nullable (§13.2); A actor types gain `device`; A §6.3 residency report gains fleet counts; A §7 close codes gain **`4412`** and the api gains the `/signal/device` upgrade path; `session_end_reason` gains `consent_required`, `policy_timeout`, `device_disabled`.
- B: no change (`org.policy_updated` and the B §3.7 outbox rule are reused as they are).
- C §1.3 step 7: device-key attestation for auto-granted P4 sessions (W45, rule 3.5b). C §2.1: `TOKEN_SOURCES` gains `service`. C §3.4: `consentLevelFamily` covers every native tier. C §4.1: secure-desktop "delivers nothing" is lifted for P4 (§5.1). C §5.1: `os.input_lock` / `os.privacy_screen` become supported in P4 and `os.sas` is added (§5.4); `ctl.event` gains `device_attest`. C §7: hand-over elevation is replaced in P4 by in-place privileged mode (W32); C §7.2's registration code also serves the worker credential (W31). C §8: playbooks may declare `vaultRefs`, which run only as device actions (rule 9.8). C §3.5: indicator and self-defence are re-imposed by the service for unattended and secure-desktop sessions.
- A.2: the server recorder is assigned to `p4_installed` sessions exactly as `p3_portable` (the worker answers the recorder offer, C §9); `recordingRequired` forces at least `server` mode.
- `apps/api`: new `src/signal/device.ts` (the `/signal/device` upgrade and handlers), `src/fleet/*`, `src/mail/*`; new env `AGENT_MSI_DIST_DIR` (branded MSI artifacts), `FLEET_DATA_KEY` (MAC encryption at rest, rule 8.2c), `VAULT_ADDR`/`VAULT_ROLE_ID`/`VAULT_SECRET_ID` (credential vault, rule 9.8), `MAIL_DRIVER`/`SMTP_URL`/`MAIL_FROM` (receipts, rule 6.4d), `DEVICE_HELLO_RATE` (§13.5), `WAKE_CONFIRM_SEC`.
- `docs/LICENSE-REGISTER.md`: add `windows-service`, `quick-xml` (if used), **WiX Toolset (MS-RL, build tool, not shipped)**, **OpenBao (MPL-2.0, separate service)**, **nodemailer (MIT-0)**; `scripts/license-check.mjs` enforces it over `cargo metadata` and the packaging tool list.
- `docs/PLAN.md` Phase D line and `docs/release.md`: add the MSI/GPO/Intune build and signing steps, the manual install/uninstall and privileged-path checks, and the accessibility contrast check (§13.5).

### 16.2 Index of changes to existing code and contracts (file, symbol, old, new)

Every change below is **additive** for existing callers unless the "new" column says otherwise; the existing smoke suites (§15.4) prove it.

**`packages/shared`**

| File | Symbol | Old | New |
|---|---|---|---|
| `src/enums.ts` | `ACTOR_TYPES` | `['user', 'desk', 'system']` | `['user', 'desk', 'system', 'device']` |
| `src/enums.ts` | `SESSION_END_REASONS` | `['denied', 'timeout', 'desk_left', 'desk_stopped', 'consent_revoked', 'assist_ended', 'token_revoked', 'error']` | the same plus `'consent_required'`, `'policy_timeout'`, `'device_disabled'` |
| `src/enums.ts` | `DEVICE_STATUSES` | `['enrolled', 'disabled']` | `['enrolled', 'disabled', 'superseded', 'retired', 'deregistered']` |
| `src/enums.ts` | `WS_CLOSE` | `{ normal: 1000, unauthenticated: 4401, forbidden: 4403, timeout: 4408, tokenBusy: 4409, sessionEnded: 4410, rateLimited: 4429, handedOver: 4411 }` | the same plus `deviceUnauthenticated: 4412` |
| `src/enums.ts` | `TOKEN_LIFETIMES.enrollment` | `{ defaultDays: 7, maxDays: 30 }` | `{ defaultDays: 7, maxDays: 180 }` (a value change; tokens already minted are unaffected) |
| `src/enums.ts` | `LIMITS` | Phase A-C keys | the same plus the §13.1 additions |
| `src/enums.ts` | re-exports | `export * from './enums-p3.js'` | plus `export * from './enums-p4.js'` (new file, §13.1) |
| `src/enums-p3.ts` | `consentLevelFamily(tier)` | `tier === 'p3_portable' ? 'p3' : 'p2'` | `isNativeTier(tier) ? 'p3' : 'p2'` (P3 result unchanged; `p4_installed` now `'p3'`) |
| `src/enums-p3.ts` | `NATIVE_TIERS`, `isNativeTier` | — | new: `['p3_portable', 'p4_installed']` and its predicate |
| `src/enums-p3.ts` | `TOKEN_SOURCES` | `['arg', 'deeplink', 'sidecar', 'filename', 'clipboard', 'manual']` | the same plus `'service'` |
| `src/errors.ts` | error codes | Phase A-C codes (incl. `consent_required`) | plus the §13.1 list |
| `src/agent/control.ts` | `AGENT_CONTROL_ARGS`, `MIN_LEVEL` | 15 ops, no `os.sas` | plus `'os.sas': z.strictObject({})`, `MIN_LEVEL['os.sas'] = 'elevated'` (not a `control.input` kind) |
| `src/agent/control.ts` | `AGENT_CONTROL_EVENT_KINDS`, `agentControlEventSchema` | `['monitors', 'capture', 'agent_level', 'clipboard', 'elevation', 'input_blocked']` | plus `'device_attest'` with branch `{ gen, sig }` |
| `src/agent/playbook.ts` | `playbookSchema`, `playbookCreateSchema`, `playbookPatchSchema`, `playbookManifestSchema` | no vault field | plus optional `vaultRefs` (rule 9.8; the manifest carries `env` names only, never paths' values) |
| `src/schemas/signal-messages.ts` | `deskHelloSchema` | `token` required (`min 1, max 4096`), `handover?` | `token?`, `workerCredential?` (43 base64url chars), refine: exactly one of the two; `handover` only beside `token` (a client that sends `token` validates as before) |
| `src/schemas/signal-messages.ts` | `sessionCreatedSchema` | no device fields | plus `device?: { id, name, keyId, publicKey }`, `unattended?: boolean` (P4 only) |
| `src/schemas/signal.ts` | the server (S→A) union | Phase A-C types | plus `device.woke`, `device.wake_failed`, `amt.sol.data` |
| `src/schemas/rest-core.ts` | `userSchema`, `orgSchema` | no fleet fields | plus `deviceGroupIds?: uuid[] \| null`; plus `fleetScopingEnabled?`, `wakerMeshEnabled?` |
| `src/schemas/rest-tokens.ts` | `createTokenRequestSchema`, the token wire object | `{ tier, typ, ttlMinutes?, ttlDays?, label? }` | plus `maxDevices?` (enrollment only, `1..LIMITS.enrollMaxDevices`); wire plus `maxDevices`, `devicesEnrolled` for enrollment tokens |
| `src/audit/actions.ts` | `session.knock` chain schema | `{ tokenId, deskLabelHash, userAgentHash }` | union of that and `{ deviceId, keyId }` |
| `src/audit/actions.ts` | `session.accepted` chain schema | `{ tokenId, onBehalfOf }` | union of that and `{ deviceId, unattended, reason: string \| null, onBehalfOf: null }` |
| `src/audit/actions-p3.ts` | `elevation.granted` chain schema | `{ opId, elevation: 'admin', claimed: true }` | plus `mode?: 'handover' \| 'service'` (absent = `handover`) |
| `src/audit/actions-p3.ts` | `sec.verified` (assist event + chain) | `{ sas, gen, skipped? }` | plus `method?: 'read_out' \| 'device_key'` (absent = `read_out`); with `device_key`, `sas` is the attested code |
| `src/audit/*` | `AUDIT_ACTIONS`, `deskEventDataSchema` | Phase A-C actions | plus the `actions-p4.ts` actions and P4 `desk.event` branches (§13.3) |
| `test/fixtures/agent/agent-names.json` | cross-language names | Phase C names | plus `os.sas`, `device_attest`, token source `service`; new `test/fixtures/fleet/*.json` |

**`packages/db`** (migration `0007_phase_d`, §13.2)

| File | Symbol | Old | New |
|---|---|---|---|
| `src/schema/enums.ts` | `actorTypeEnum`, `sessionEndReasonEnum`, `deviceStatusEnum` | mirror the old shared arrays | follow the new shared arrays (ALTER TYPE ADD VALUE) |
| `src/schema/enums.ts` | new pgEnums | — | `device_platform`, `device_action_kind`, `device_action_state`, `wake_method`, `wake_state`, `tamper_state` |
| `src/schema/session.ts` | `session.tokenId` | `uuid('token_id').notNull()` | nullable, with CHECK `(token_id IS NOT NULL OR device_id IS NOT NULL)` |
| `src/schema/session.ts` | `session` columns, indexes | — | plus `device_id`, `unattended`, `unattended_policy`; partial unique index `session_device_open_unique` |
| `src/schema/token.ts` | `token` | no device counters | plus `max_devices`, `devices_enrolled` |
| `src/schema/token.ts` | `device` | A placeholder (`name`, `public_key`, `status`, `group_name`, `tags`, `capabilities`, `enrolled_by_token_id`, `last_seen_at`) | plus the §13.2 columns; `group_name` deprecated (kept, unused) |
| `src/schema/org.ts` (user, org) | `user`, `org` | no fleet columns | plus `user.device_group_ids`; `org.waker_mesh_enabled`, `org.fleet_scoping_enabled`, `org.unattended_policy` |
| `src/schema/playbook.ts` | `playbook` | no vault column | plus `vault_refs` jsonb null (rule 9.8) |
| new tables | — | — | `device_group`, `device_action`, `wake_attempt`, `amt_sol` |

**`apps/api` and `apps/web`: native-tier branches** (old `tier === 'p3_portable'` / `!== 'p3_portable'` meaning "native agent session" → new `isNativeTier(tier)`)

| File | Line today | Change |
|---|---|---|
| `apps/api/src/signal/desk.ts` | 53 (`EXPECTED_CLIENT`) | add `p4_installed: 'native'` |
| `apps/api/src/signal/desk-consent.ts` | 67 | → `isNativeTier` |
| `apps/api/src/signal/desk-events.ts` | 50 | → `isNativeTier` |
| `apps/api/src/signal/desk-p3.ts` | 23, 55 | → `isNativeTier` |
| `apps/api/src/signal/conn.ts` | 277 | → `isNativeTier` |
| `apps/api/src/signal/agent-manifest.ts` | 65 | → `isNativeTier` |
| `apps/api/src/signal/messages.ts` | 82 | → `isNativeTier` (and add the P4 `device`/`unattended` fields) |
| `apps/api/src/signal/recorder.ts` | 63, 74 | → `isNativeTier` |
| `apps/api/src/routes/session-events.ts` | 70 | → `isNativeTier` |
| `apps/api/src/routes/playbooks.ts` | 162 | → `isNativeTier` |
| `apps/api/src/routes/internal-recordings.ts` | 44 | → `isNativeTier` |
| `apps/api/src/services/scope.ts` | 60 | → `isNativeTier` |
| `apps/web/src/assist/console/ConsolePage.tsx` | 41, 73 | → `isNativeTier` (AgentConsole for P4) |
| unchanged, deliberately `p3_portable`-only | `routes/download.ts:99`, `routes/tokens.ts:148/152/162`, `signal/desk.ts:336`, `signal/handover.ts:50` (elevation hand-over, not used in P4, W32), `web/.../TokensPage.tsx:158`, `JoinPage.tsx`, `JoinP3.tsx`, `CreateTokenDialog.tsx` | the portable download/join/sidecar/desk-code flows |

Line numbers are those of commit `536ca9f` and are a guide; the binding rule is P1's (every "native agent session" test uses `isNativeTier`), checked by `test/native-tier.test.ts`.

**`apps/api` other**: `src/lib/logger.ts` `REDACT_PATHS` gains the §14 paths; the hub gains the `/signal/device` upgrade route beside `/signal` (the existing `deskOnly` logic is unchanged).

**Phase A / B / C contract sections amended** (apply in those documents with a pointer here)

| Contract | Section | Old | New |
|---|---|---|---|
| A | §2.3 permission matrix | no device rows | the §7.1 rows |
| A | §3.2 token lifetimes | enrollment 7 d default / 30 d max, enroll not functional | 7 d / 180 d, `maxDevices`, functional via §3.2 here |
| A | §4.2 data model | `session.token_id` not null; `device` placeholder; actor types `user`/`desk`/`system` | nullable with CHECK; extended `device`; actor type `device` |
| A | §6.3 residency report | no fleet counts | plus the §7.2 residency fields |
| A | §7 signaling, close codes | `/signal` only; close codes to 4429 | plus `/signal/device` (§3.4) and `4412` |
| B | — | — | no change |
| C | §1.3 step 7 | read-out SAS gate for every native session | unchanged for P3 and person-approved P4; device-key attestation for auto-granted P4 (rule 3.5b) |
| C | §2.1 token sources | six sources | plus `service` (worker credential) |
| C | §3.4 consent families | P3 family for `p3_portable` only | for every native tier |
| C | §4.1 secure desktop | delivers nothing | P4 captures it under rule 5.1c |
| C | §5.1 control ops | `os.input_lock`/`os.privacy_screen` → `not_supported`; no `os.sas`; six `ctl.event` kinds | supported in P4 (§5.4); `os.sas` added; `device_attest` event |
| C | §7 / §7.2 elevation and registration | hand-over relaunch; registration by hand-over token | P4 uses in-place privileged mode (W32); the registration code also accepts a worker credential (W31) |
| C | §8 playbooks | no vault references | optional `vaultRefs`, device actions only (rule 9.8) |
| C | §13.2 audit | `elevation.granted` without `mode`; `sec.verified` without `method` | both gain the optional field |

*End of Phase D contracts. Amend this file first, then the code.*
