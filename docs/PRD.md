# IndiansAssist, Product Requirements Document

Remote support and remote access platform, self hostable, open source first, security by default.

Prepared for: Claude Code build sessions
Owner: aio solution (Dhruv Mishra)
Domain: indiansassist.com
Hosting posture: first party, our own infrastructure (indianscloud.com), India data residency as the default

---

## 0. How to read this document

This PRD is written to be fed to Claude Code as the source of truth for an actual build. It leads with the product shape, then goes deep on each of the four packages, the technology for each, the cross platform plan, the security model, and a backlog of out of the box ideas worth stealing from nobody because they are ours.

Two words are used throughout and they are the opposite of what they sound like, so fix them in your head now:

- **Desk** = the client, the computer being helped, the employee's machine.
- **Assist** = the IT admin, the person giving help, the technician console.

So "control the tab from Assist" means the technician controls the employee's browser tab. "Desk's browser" means the employee's browser.

---

## 1. Why this exists

Every tool in this space forces a trade. TeamViewer and AnyDesk are fast but closed, priced per channel, and your session data lives on their cloud. ScreenConnect is powerful for MSPs but its self hosted server has a rough security history. RustDesk is open and self hostable but its recordings are not tamper proof and formal support is thin. Chrome Remote Desktop is free but has no auditing, no real file transfer, and cannot wake a sleeping machine.

IndiansAssist takes the open and self hosted path (so data stays on our server), adds a tamper evident audit trail that RustDesk lacks, and ships as four packages of rising capability so a customer pays only for the depth they need. The lightest package needs nothing installed at all. The heaviest gives unattended access and remote power on.

### Product principles

1. **Least capability that does the job.** A browser screen share should never need a driver. Elevation is requested only when a feature truly needs it, and the reason is logged.
2. **Self hostable end to end.** No mandatory third party cloud. Signaling, relay, database, auth, all run on our boxes.
3. **Encrypted in transit and, where possible, end to end.** The relay should never be able to read a session.
4. **Every privileged action is on the record.** Append only, hash chained, exportable. This is our answer to the compliance crowd.
5. **Consent is visible to the Desk user.** No silent watching in attended mode. A banner, a tray state, a clear indicator.

---

## 2. Who uses it

| Persona | Role | What they do |
|---|---|---|
| IT admin / technician | Assist | Signs up, creates support tokens, runs sessions, views audit logs |
| Org owner / admin | Assist (elevated) | Manages team, branding, SSO, billing, policy |
| Employee / end user | Desk | Receives a link or token, lets the technician in, gets helped |
| Compliance / security officer | Observer | Reads audit logs, exports session records, sets data policy |
| Supervisor | Assist (senior) | Joins or takes over a junior technician's live session |

---

## 3. The four packages

Packages rise in complexity and capability. Each one is a superset of the behaviours below it in spirit, though the delivery mechanism changes. A customer buys a tier; the tier decides which agent the Desk runs and which features light up.

### Package 1, Browser screen share (zero install)

The Desk opens a link in any modern browser and shares their screen. The Assist watches live in the technician console. Nothing is downloaded.

**What works**
- Live screen view of the Desk (full screen, a window, or a browser tab, whatever the browser's picker allows).
- In session text chat.
- Voice call.
- File transfer both ways.
- Assist side annotation (draw an arrow, highlight a region, the Desk sees it as an overlay).
- Session recording on the Assist side.

**What cannot work here, and why**
- No control of the Desk's mouse or keyboard. A web page cannot drive the operating system. Control starts at Package 2 (browser only) and becomes real OS control at Package 3.

**Technology**
- Screen capture: `getDisplayMedia()` (WebRTC Screen Capture API) in the Desk browser.
- Transport: `RTCPeerConnection`, media over SRTP, data (chat, files, annotation) over `RTCDataChannel`.
- Signaling: our own WebSocket service.
- NAT traversal: self hosted `coturn` for STUN and TURN. P2P first, relay fallback.
- Recording: `MediaRecorder` on the Assist side, or server side recording via a headless `pion/webrtc` (Go) consumer when a durable, signed recording is required.

### Package 2, Browser extension on the Desk (lightweight, browser scoped control)

A Chrome extension (MV3) runs on the Desk. Instead of streaming pixels, it streams the DOM, like Microsoft Clarity does, so the Assist sees exactly what the Desk sees with almost no bandwidth, and can control the browser.

**What works**
- **DOM mirroring, Clarity style.** Initial DOM snapshot, then a `MutationObserver` stream, plus input and scroll and navigation events, all uploaded so the Assist replays the Desk's browser live. This is the open source technique behind Clarity and LogRocket.
- **Browser control from Assist.** Switch, create, close, reload, navigate tabs. Rearrange and control tab groups. Pin, mute, move tabs.
- **Side panel experience.** Chat, voice call, and file share live in Chrome's Side Panel so they do not cover the page the Desk is working in.
- **Backstage for the browser.** The Assist can act on a background tab (read, navigate, fill a form draft) without yanking the Desk's focus, a browser level version of ScreenConnect's Backstage.
- **Field privacy.** Password inputs and fields marked sensitive are masked in the mirrored stream by default.

**Technology**
- Recording and replay: `rrweb` (open source, MIT), the library that captures a DOM snapshot plus mutations plus events and replays them faithfully.
- Extension: Chrome Manifest V3, service worker background, content script for capture.
- Side panel: Chrome **Side Panel API** for chat, voice, files.
- Tab and group control: `chrome.tabs`, `chrome.tabGroups`, `chrome.windows`.
- Deeper in page control when needed: `chrome.debugger` (Chrome DevTools Protocol) for reliable input injection into the page, used sparingly and with a visible indicator.
- Voice: WebRTC audio, same stack as Package 1.
- Cross browser: Firefox (WebExtensions, has a sidebar but no exact Side Panel twin, adapt), Edge (same as Chrome). Safari extension is a separate, smaller target.

### Package 3, Portable native client (no install, admin aware, self deleting)

A single downloadable executable. It runs without admin rights and delivers the maximum features possible in a normal user context. If the user elevates (UAC), the full feature set unlocks. On exit, the portable client removes itself, like TeamViewer QuickSupport.

**What works without admin (user context)**
- Full screen view of the Desk, all monitors.
- Mouse and keyboard control at the user level.
- File transfer.
- Chat and voice.
- Clipboard sync.
- Session recording.
- Pre approved scripts that do not need elevation.

**What unlocks with admin (elevation)**
- Capture across the secure desktop (UAC prompts, lock screen) on Windows.
- Service grade input so control survives UAC dialogs.
- Install as a persistent agent (this is the doorway to Package 4).
- Privileged scripts and system diagnostics.

**Self delete on exit**
- Portable mode leaves no installed footprint. On session end it wipes its working directory and the binary (Windows: a small relaunch-and-delete stub; macOS and Linux: unlink on quit).

**Technology**
- Language: **Rust**. Memory safe, single binary, cross platform, and the same choice RustDesk made for good reasons. We can study RustDesk's architecture (AGPL) for the hard parts but keep our own codebase and licensing clean.
- Encryption: end to end with `libsodium` / NaCl, per session keys, relay stays blind.
- Codecs: VP8, VP9, AV1 where hardware allows, H.264 fallback, via `rav1e` / `openh264` / platform encoders.
- Capture and input per platform, see section 5.
- Transport: QUIC or TLS over our relay, P2P first via `coturn`.

### Package 4, Full install, unattended access, remote wake and power on

Installed as a system service. Always available without anyone sitting at the Desk. Can be woken or powered on remotely. Deployable at scale across a fleet.

**What works**
- Everything in Package 3, permanently and unattended.
- **Wake on LAN.** Magic packet to a sleeping machine on the same subnet.
- **Remote power on from fully off**, where the hardware supports Intel AMT / vPro, via a self hosted AMT path.
- **Mass deployment.** MSI with GPO on Windows, PKG and MDM profile on macOS, deb / rpm and config management on Linux.
- **Boot time and pre login access** through the service.
- **Fleet grouping, tags, and policy** per group.

**Technology**
- Windows service, macOS `launchd` daemon, Linux `systemd` unit.
- Wake on LAN: magic packet sender. Because WoL needs something awake on the subnet, ship a tiny **LAN waker** role (any one Package 4 agent on a subnet can wake its peers), see out of the box ideas.
- True power on from off: Intel AMT / vPro over the self hosted channel, optional and hardware gated.
- Deployment tooling and signed installers per platform.

---

## 4. Full feature matrix, mapped to packages

Every feature from the comparison matrix, and where it lands. "Browser" means scoped to the browser only.

| Feature | P1 Browser share | P2 Extension | P3 Portable | P4 Installed |
|---|---|---|---|---|
| Attended (on demand) support | Yes | Yes | Yes | Yes |
| Unattended access | No | No | Session only | Yes, persistent |
| File transfer | Yes (data channel) | Yes (side panel) | Yes | Yes |
| Multi monitor | Single shared surface | Browser only | Yes | Yes |
| Session recording | Yes | Yes (rrweb replay) | Yes | Yes |
| Backstage / background work | No | Browser backstage | Yes | Yes |
| Remote CLI / scripting | No | No | Yes (elevation aware) | Yes |
| Remote control of OS | No | Browser tab/group only | Yes (user, full on admin) | Yes |
| Mobile support (Android host, iOS view) | Share from mobile browser | Android extension (limited) | Android host app | Android host app |
| Camera sharing (support physical hardware) | Phone camera via web | No | Phone camera stream | Phone camera stream |
| White labelling / custom client | Branded web room | Branded extension | Branded installer | Branded installer |
| Mass deployment (MSI, GPO) | n/a | Enterprise extension policy | Portable push | Yes, full |
| Wake on LAN | No | No | No | Yes |
| Remote power on from off (AMT) | No | No | No | Yes, hardware gated |
| Remote printing | No | No | Yes | Yes |
| In session chat / VoIP | Yes | Yes (side panel) | Yes | Yes |
| PSA / ticketing integrations | Via console | Via console | Via console | Via console |
| SSO / SAML | Assist side | Assist side | Assist side | Assist side |
| Audit logs / compliance reporting | Yes | Yes | Yes | Yes, deepest |
| Self hosted | Yes | Yes | Yes | Yes |

PSA integrations, SSO, branding, and audit are console and backend capabilities, so they apply across every package rather than being tied to one.

---

## 5. Cross platform plan, maximum possible per OS

The philosophy is the same everywhere: do the most the platform allows in user context, unlock the rest with the platform's own elevation or permission model, and be honest about hard limits (iOS cannot be controlled, full stop).

### Windows (primary target)
- Capture: DXGI Desktop Duplication (fast, GPU path), GDI fallback.
- Input: `SendInput`; service context for secure desktop and UAC survival.
- Unattended: Windows Service.
- Wake: magic packet; power on via AMT where present.
- Self delete: relaunch-and-delete stub.
- Deploy: MSI + GPO, Intune.

### macOS
- Capture: ScreenCaptureKit (modern), needs Screen Recording permission.
- Input: CGEvent, needs Accessibility permission.
- Unattended: `launchd` daemon, plus a login item.
- Constraint: Apple's permission prompts and notarization are mandatory; portable self delete is easy, but permissions must be granted once by the user. TCC cannot be bypassed, and we will not try.
- Deploy: signed and notarized PKG, MDM profile to pre grant permissions on managed Macs.

### Linux
- Capture: PipeWire portal (`xdg-desktop-portal`) for Wayland, XShm / X11 for Xorg.
- Input: `uinput` (works under Wayland) or `XTest` (X11).
- Unattended: `systemd` service.
- Deploy: deb and rpm, Ansible / config management.

### Android (host and controller)
- Host (be controlled): `MediaProjection` for screen, Accessibility Service for input control, foreground service for persistence.
- Controller (give help): full native or web console.
- Constraint: control needs the Accessibility Service the user explicitly enables; some OEM skins restrict background behaviour.

### iOS and iPadOS
- Host: screen **sharing only** via ReplayKit Broadcast Extension. No control, Apple does not allow it.
- Controller: full featured, an iPhone can be the Assist.
- Be explicit in the UI so nobody expects iOS control.

### Browser layer (P1 and P2)
- P1 works on any Chromium browser, Firefox, Safari, and their mobile versions (getDisplayMedia support varies on mobile, test).
- P2 ships for Chromium (Chrome, Edge) first, Firefox second, Safari as a later, smaller effort.

---

## 6. The onboarding and token flow

This is the core user journey the build must get right.

1. **IT admin signs up** on indiansassist.com and lands on the Assist dashboard.
2. In the dashboard the admin **creates a new support token**. A token is bound to the admin (and their org), carries the package tier, and has a lifetime policy (one time, time boxed, or persistent for unattended).
3. The dashboard gives the admin a **download link** carrying that token.
4. The admin **sends the link to the employee** (the Desk).
5. The employee opens the link and clicks download. Two things happen on that click:
   - the admin's **token is copied to the employee's clipboard**, and
   - the **IndiansAssist client downloads**.
6. The employee **runs the client**. On start it reads the token from the clipboard and **polls periodically until it connects** to that token's admin.
7. **Fallback:** if the token is no longer on the clipboard (the employee copied something else), the client shows a field to **paste or type the token manually**, and the download page keeps a one click "copy token again" button.

### Make this flow more secure without changing its shape

The clipboard is convenient but it is readable by any app and it gets overwritten easily, so treat it as a convenience channel, not the security boundary. Layer these on top, all optional, all keeping the same employee experience:

- **Signed token.** The token is a short, signed artifact (JWT style or a signed opaque blob). The client verifies the signature and the backend verifies binding, so a stray or stale clipboard value cannot connect to the wrong admin.
- **Token in the download itself.** Serve a per download stub whose filename or an adjacent `.iaconfig` carries the signed token, so even an empty clipboard still connects. Clipboard becomes the fast path, the embedded token the reliable path.
- **One time deep link.** `indiansassist://join?t=...` as a primary path on desktops where the protocol handler is registered, clipboard as fallback for first run.
- **QR and NFC for mobile.** The dashboard shows a QR; the employee's phone app reads it. No clipboard involved.
- **Short lived by default.** Attended tokens expire fast (minutes). Only Package 4 unattended tokens persist, and those are enrollment tokens that mint a long lived device identity on first connect, then are discarded.
- **Admin sees the knock.** Before any data flows, the admin gets a "Desk X wants to connect with token Y" confirmation, so a leaked token alone does not grant a session.

---

## 7. Security and trust model

This is the part that wins enterprise and government adjacent clients in India, so it is not an afterthought.

- **Transport:** TLS 1.3 everywhere, QUIC where we can.
- **End to end encryption:** per session symmetric keys negotiated between Desk and Assist; the relay (`coturn` / our media relay) never holds plaintext. libsodium / NaCl.
- **Identity:** Assist users authenticate through our auth service with optional SSO. Desk devices in Package 4 get a cryptographic device identity on enrollment.
- **Authorization:** role based (technician, senior technician, org admin, auditor, read only observer). Per group and per device scoping.
- **Consent:** attended sessions always show the Desk a visible indicator and a consent prompt. Unattended access is policy gated and logged, and can be set to require a one time local approval window during enrollment.
- **Just in time elevation:** admin rights are requested only for the specific action that needs them, with a reason string captured in the audit log.
- **Tamper evident audit log:** append only, hash chained (each entry hashes the previous), optionally anchored. This is our direct answer to "RustDesk recordings are not signed." Session recordings are hashed and the hash is written into the chain, so a recording can be proven unaltered.
- **Credential vault:** for Package 4 privileged workflows, store secrets in a self hosted vault (**OpenBao**, the open source fork of Vault, or HashiCorp Vault) with injection rather than exposure, a lightweight take on BeyondTrust style credential injection.
- **Data residency:** default to our India infrastructure, with region pinning so a customer can prove where session data lives (relevant to the DPDP Act).
- **Privacy by default:** password fields masked in P2 mirroring; privacy screen and input lock for unattended work; technician watermark overlay for forensics.
- **Secure self host:** signed server releases, minimal attack surface, documented hardening, because ScreenConnect's self hosted CVEs are the cautionary tale we are reacting to.

---

## 8. Recommended open source stack

All self hostable, all permissively or copyleft licensed in a way we can live with.

| Layer | Choice | Why |
|---|---|---|
| Native agent (P3, P4) | **Rust** | Memory safe, single binary, cross platform, proven for this use case |
| Browser extension (P2) | MV3 + **rrweb** (MIT) | rrweb is the open source Clarity technique |
| Realtime media | **WebRTC**, `pion` (Go) server side, `coturn` | Mature, self hostable STUN/TURN |
| Signaling + API | **Node.js + TypeScript** (your home turf) or **Go** | Pick TS for speed of build, Go for a single binary backend |
| Auth + SSO/SAML/OIDC | **Keycloak** or **Ory** (self hosted) | Covers the enterprise SSO feature cleanly |
| Database | **PostgreSQL** | Reliable, our standard |
| Cache / presence / token polling | **Redis** | Session state, token poll fan out |
| Secrets / credential vault | **OpenBao** or Vault | Credential injection for privileged flows |
| Object storage (recordings, files) | **MinIO** (S3 compatible, self hosted) | Keeps recordings on our infrastructure |
| Audit log | Postgres append only + hash chain | Tamper evident, exportable |
| Codecs | VP8/VP9/AV1/H.264 via `rav1e`, `openh264`, platform encoders | Open where possible |
| Deployment | Docker Compose for self host, Helm for scale | One command self host story |

Note on licensing: we can read RustDesk (AGPL) and ScreenConnect behaviours for understanding, but we write our own code. rrweb (MIT), coturn (BSD), pion (MIT), Keycloak (Apache 2), PostgreSQL, Redis, MinIO (AGPL, mind the terms) are all fine to build on. Keep a license register in the repo.

---

## 9. System shape (high level)

```
          indiansassist.com (web)
                 |
        +--------+---------+
        | Assist dashboard |  signup, tokens, console, audit, billing
        +--------+---------+
                 |
   +-------------+--------------------------------+
   |             |                |               |
 Auth svc    API + signaling   Media relay     Object store
 (Keycloak)  (TS/Go + WS)      (coturn/pion)   (MinIO)
   |             |                |               |
   +------ PostgreSQL / Redis / OpenBao ----------+
                 |
        token poll + E2EE session
                 |
   +-------------+-------------+-------------+
   |             |             |             |
 P1 browser   P2 extension   P3 portable   P4 service
 (Desk web)   (Desk Chrome)  (Desk binary) (Desk fleet)
```

---

## 10. Data model sketch

- **org**: id, name, branding, data region, plan tier, SSO config.
- **user** (Assist): id, org_id, role, auth_ref, status.
- **device** (Desk, P4): id, org_id, enrollment, public key, last seen, group, tags, capabilities.
- **token**: id, org_id, created_by, tier, type (one time / timed / enrollment), expiry, status, signature.
- **session**: id, org_id, assist_id, desk_ref, package, start, end, consent_state, path (p2p/relay), recording_ref, hash_chain_tail.
- **audit_entry**: id, org_id, session_id, actor, action, reason, prev_hash, hash, timestamp.
- **recording**: id, session_id, storage_ref, sha256, chained_into (audit_entry id).
- **integration**: id, org_id, type (zoho_desk, servicenow, jira, freshdesk), config.

---

## 11. API surface (first cut)

- `POST /auth/*` via auth service (SSO redirect, token exchange).
- `POST /tokens` create support token, returns signed token + download link.
- `GET /download?t=...` serves per download stub, embeds signed token, triggers clipboard copy on the page.
- `WS /signal` signaling for WebRTC and token polling (`poll token -> waiting | matched`).
- `POST /sessions` open a session (admin confirms the knock).
- `GET /sessions/:id/audit` audit trail.
- `GET /recordings/:id` signed, hash verified fetch.
- `POST /integrations/:type/ticket` push a session summary into PSA.
- `POST /devices/:id/wake` Wake on LAN / AMT power on (P4).
- `POST /devices/:id/script` run a pre approved playbook (P3/P4, elevation aware).

---

## 12. Out of the box features worth building

These are the differentiators. None of them are standard in the incumbents, and several directly beat a named competitor's weakness.

1. **Tamper proof session records.** Hash chained audit plus signed recordings. Say out loud what RustDesk cannot: "prove your recording was not edited." Strong for banking, healthcare, government clients.
2. **DPDP ready data residency.** Region pin to India, a one page data residency report per customer. Sells itself here.
3. **Privacy guard.** Auto mask password and marked sensitive fields in P2 mirroring, privacy screen and input lock for unattended work, and a Desk visible technician watermark (name + ID burned onto the screen) that deters and forensically traces misuse.
4. **Just in time elevation with reason capture.** Admin is requested only for the action that needs it, and the technician must type why. Clean audit story, lower blast radius.
5. **LAN waker mesh.** Any one Package 4 agent on a subnet can wake its sleeping peers via magic packet, solving WoL's "needs something awake" problem without extra hardware. Optional AMT path for cold power on.
6. **Pre approved playbooks instead of raw shell.** Technicians run vetted scripts (clear temp, reset print spooler, collect logs) from a catalog, each run logged, instead of opening a terminal. Safer, auditable, trainable for junior staff.
7. **AI session summary, locally runnable.** At session end, auto summarize what happened and draft the ticket note. Offer a local LLM option so summaries never leave our infrastructure, which matters to privacy sensitive clients.
8. **Phone as a support camera.** The Desk points their phone at a router or a cable; the Assist sees it live. Covers physical hardware support (TeamViewer Assist AR, Rescue Lens) without buying into their ecosystem.
9. **Supervisor join and session handoff.** A senior can silently observe, whisper to the junior, or take over, and a session can be transferred between technicians without the Desk reconnecting. BeyondTrust behaviour, open source cost.
10. **Network path transparency.** Show whether a session is P2P or relayed, and the live latency and codec, so technicians and auditors can see the connection quality, not just trust it.
11. **Low bandwidth and mobile data saver mode.** P2's DOM streaming is nearly free on bandwidth; for P3/P4 add an aggressive low bitrate mode tuned for Indian mobile links. A real edge over pixel only tools on weak connections.
12. **Offline action queue.** File pushes and playbooks queued for an unattended device that is currently off, executed and logged when it next checks in.
13. **Self healing, tamper alerting agent.** The P4 service notices if it is stopped or modified and raises an alert, so a compromised or disabled agent is visible rather than silent.
14. **Consent receipts.** The Desk user gets a record of what was accessed and done during the session, by email or in app. Builds trust, useful for compliance.
15. **White label per org, multi tenant from day one.** Branded web room, branded extension, branded installer, each org isolated. This is also the aio solution resale angle.
16. **Blur on share.** Before the Desk shares in P1, a one click option to pre blur notifications and the taskbar, so a quick screen share does not leak a popup.

---

## 13. Non functional requirements

- **Latency:** P2P median under 100 ms on good links; graceful relay fallback.
- **Bandwidth:** P2 under 100 kbps typical; P3/P4 adaptive, with a sub 300 kbps floor mode.
- **Scale:** 10k concurrent sessions per region cluster as a design target.
- **Availability:** 99.9 percent for signaling and console.
- **Security:** independent review before GA; documented hardening for self host.
- **Accessibility:** console meets WCAG AA.
- **Observability:** metrics, structured logs, per session trace, all self hosted.

---

## 14. Build order (phased, for Claude Code)

A sensible sequence so each phase ships something usable.

**Phase A, foundation + Package 1**
Auth, org and user model, token creation, download page with clipboard copy, signaling service, coturn, WebRTC screen share, chat, voice, file transfer, Assist console with live view and recording, append only audit skeleton.

**Phase B, Package 2**
MV3 extension, rrweb capture and replay, side panel chat/voice/files, tab and tab group control from Assist, field masking, browser backstage.

**Phase C, Package 3**
Rust portable agent, DXGI capture and SendInput on Windows first, E2EE, user context features, admin elevation unlock, self delete, playbook runner, recording with hash into the audit chain.

**Phase D, Package 4**
Service install, unattended enrollment and device identity, Wake on LAN, LAN waker mesh, AMT path, MSI/GPO deployment, fleet groups and policy.

**Phase E, cross platform + enterprise**
macOS and Linux agents, Android host, iOS share and controller, SSO/SAML, PSA integrations, credential vault, data residency reporting, AI summaries.

Within each phase, Windows and Chromium are the first platform; others follow using section 5.

---

## 15. Decisions (settled 23 Oct 2026)

These were the open questions. They are now locked and the rest of the document should be read in their light.

1. **Backend language.** TypeScript for the API, signaling and console. Go or Rust for the media relay (pick Go with `pion` unless the Rust agent team wants to own the relay too, in which case Rust with `webrtc-rs`). Decide at the start of Phase A and do not revisit.
2. **Pricing model.** Per technician, Zoho Assist style. Each Assist seat is a licence; concurrent sessions are not metered. The token model already supports this: a token belongs to a technician, and a technician's seat sets the package tier. Billing counts active Assist users per org per month.
3. **AMT remote power on.** Ships in v1 of Package 4, not deferred. Hardware gated by detection (agent reports whether AMT or vPro is present and provisioned) and surfaced in the fleet view as "Cold power on: available / not available". Self hosted AMT management path, no Intel cloud dependency.
4. **Hosting.** Multi region from the start. India is the default region; add at least one EU and one US/Middle East region for export clients. Region is chosen per org at signup and pinned; session data, recordings and audit logs never leave the org's region. The data residency report in section 12 lists the region.
5. **Licensing of our code.** Source available. The code is published and readable, self hosting is permitted under our terms, commercial redistribution and offering it as a competing service are not. Because we are source available and not AGPL, AGPL projects (RustDesk, MinIO) are reference reading only and must not be copied into our codebase. Use `pion`, `rrweb`, `coturn`, `Keycloak`, PostgreSQL and Redis freely; for object storage prefer an S3 compatible store with a permissive licence (SeaweedFS, Garage, or a managed S3 per region) over MinIO to avoid AGPL friction. Keep a licence register in the repo.
6. **Mobile scope for v1.** Android host ships in v1 (MediaProjection for screen, Accessibility Service for control, foreground service for persistence), alongside the Android and iOS controller apps and iOS share only. Phase E's mobile line moves up: Android host is part of Phase C deliverables.

### Knock on changes to earlier sections

- Section 3, Package 4: AMT is a v1 feature, not "optional".
- Section 7, data residency: multi region with per org pinning, not India only.
- Section 8, object storage: S3 compatible permissive store or managed S3 per region, MinIO removed.
- Section 10, data model: `org.data_region` is mandatory and immutable after creation; add `technician_seat` with tier for per seat billing.
- Section 14, build order: Android host moves from Phase E into Phase C; multi region infrastructure (region aware routing, per region relay and storage) is part of Phase A so nothing is built single region first.

---

*End of PRD. This document is the build contract; keep it in the repo and amend it when further decisions are made.*
