# Phase B technical contracts (binding): Package 2, Chrome MV3 extension on the Desk

Status: binding for Phase B. Revision 3, 23 Oct 2026 (revision 2 completed the draft; revision 3 resolves the cross-engineer review: wire/chain split for hosts, frame fragmentation, extension Origin rule, join handshake trust, resume and peer-connection rebuild, attestation outbox, dual attestation, masking and reveal bounds, backstage consent, relay pacing, replayer packaging, and the Phase A deferrals due in B). Implements PRD section 3 "Package 2", section 14 "Phase B", section 7 (security) and section 12.3 (privacy guard). **Phase A contracts (`docs/specs/phase-a-contracts.md`) stay binding**; this document only adds to them and lists every place it amends them (section 14). Four engineers build from it in parallel without talking: **shared/api** (`packages/shared`, `packages/db`, `apps/api`), **extension** (`apps/extension`), **web** (`apps/web`), **integration** (Playwright e2e, bandwidth gate, smoke, licence register, infra). If something here is wrong, amend this file first, then the code.

Vocabulary (inverted): **Desk** = the employee's browser being helped (runs the extension). **Assist** = the technician console (`apps/web`). "P2" = Package 2, tier `p2_extension`.

Conventions: everything in the Phase A conventions table applies (camelCase wire keys, `ts` = integer ms, ISO 8601 elsewhere, lower snake_case enums, base64url without padding). New ones:

| Convention | Rule |
|---|---|
| `tabId`, `windowId`, `groupId` | Chrome's own integers (`chrome.tabs.Tab.id` etc.), never remapped; `groupId` is `-1` when ungrouped, as Chrome reports it |
| `nodeId` | rrweb mirror id (integer) of a node in the mirrored tab, as assigned by `record()` on the Desk; the Assist replayer's mirror holds the same ids. rrweb's `Mirror.getId` returns `-1` for an unknown node; on the wire that is always `null` |
| Normalised coordinates | floats `0..1`, 4 decimals (shared `roundCoord`), origin top-left; `nx`/`ny` relative to a node's client rect, `vx`/`vy` relative to the tab viewport **as reported by the latest rrweb `Meta` event (`width`, `height`)** of that tab |
| `host` on the wire, `hostHash` in the chain | a `host` field anywhere on the wire is a hostname only (lower-case, IDNA-ASCII, no port, no path, `<= 253` chars, accepted only when `normaliseHostPattern(host)` returns it unchanged without a `*.` prefix). The server never writes it: every chain `data` carries `hostHash = piiHash(org, host)` instead (A §5.3 PII rule, same as `name -> nameHash`). No client ever sends a key ending in `Hash` |
| `opId` | correlation id of one control request in the chain: `sha256Hex(sessionId + ':' + ctl.req.id).slice(0, 16)`; computed by both reporters (§3.7) |
| Section references | "A §7.3" = Phase A contracts section 7.3; "§5" = this document |
| Package names | `@indiansassist/extension` (`apps/extension`) joins the four Phase A packages |
| Chrome minimum | `minimum_chrome_version: "120"` (sidePanel 114, offscreen 109, WS keepalive 116, `runtime.getContexts` 116, 30 s alarms 120); Edge same build; Firefox notes in §9.7 |
| Libraries added | `rrweb` 2.x umbrella package (MIT), one exact version pinned in the root `pnpm-workspace.yaml` `catalog:` and consumed as `catalog:` by both `apps/extension` and `apps/web` (record and replay must match); `@types/chrome` (MIT); `@axe-core/playwright` (MIT); `eslint-plugin-no-unsanitized` (MPL-2.0, dev only, §12.1); `@playwright/test` (already present) |
| Ownership of names | every new wire message, enum, limit and schema is defined once in `packages/shared` and imported from `dist/` by the api, the web app and the extension; §15 is the index |
| Text insertion in the extension | every string that did not originate in the extension bundle (technician names, reasons, chat, file names, page titles, labels read from the mirrored page, policy text) is inserted with `textContent` / `createTextNode` / `setAttribute` of a non-URL attribute only; `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` and `Range.createContextualFragment` are banned in `apps/extension` (ESLint `no-unsanitized/method` and `no-unsanitized/property` as errors) |

---

## 1. Scope and principles

| # | Principle | Consequence |
|---|---|---|
| P1 | **DOM, not pixels.** The Desk sends an rrweb snapshot plus mutation stream; the Assist replays it. No `getDisplayMedia`, no video track in a P2 session. | Target under 100 kbps typical (§13.4); the server never carries mirror payloads except the §4.6 relay fallback (a declared E2EE gap, Y22), and never persists them except the opt-in recording of §4.7 |
| P2 | **Browser-scoped control only.** Everything the Assist can do goes through `chrome.tabs`, `chrome.tabGroups`, `chrome.windows`, DOM dispatch in a content script, or the three CDP methods of `CDP_ALLOWED_METHODS` on one attached tab. No OS input, no file system, no other apps, no other CDP domain. | The control op list of §5 is closed; anything not listed answers `not_supported`. Every `url` argument passes `assertNavigableUrl` (§5.2) |
| P3 | **Visible indicators, always.** Badge, action icon, a bar in every mirrored tab, the Chrome debugging infobar when deep control is on, the side panel. Nothing is ever hidden or suppressed, and the bar defends itself (§3.3). | §3.3; a build that passes `--silent-debugger-extension-api` is not a supported deployment |
| P4 | **Masked by default.** Every input value is masked; `[data-ia-sensitive]` text and `[contenteditable]` text are masked; `[data-ia-block]` is never captured; a field that was ever a password can never be unmasked; policy deny-listed hosts are never mirrored. Unmasking is per field or per tab, Desk-approved, time-bounded, with a technician reason, and in the chain (both the request and the outcome). | §8 |
| P5 | **Consent is tiered and reversible.** The Desk picks a level (`view`, `tab_control`, `in_page`, `deep_control`), a scope (`current_tab`, `all_tabs`) and whether background tabs are allowed before anything flows; may raise or lower it during the session; may pause any tab; may hide a revealed field again; may stop at any time. The server cannot see the data channel, so it enforces nothing above the granted level, but it records every change, and the extension refuses ops above the level. | §3, §5.2, §6 |
| P6 | **Reuse Phase A.** Same `/signal`, same token format with tier `p2_extension`, same state machine, same `RTCPeerConnection` and data-channel infrastructure, same chat/file/ctrl protocols, same audit chain, same recordings endpoints. | Every Phase A rule applies to a P2 session unless §14 says otherwise |
| P7 | **Nothing runs in pages outside a session, and nothing of ours runs in protected pages during one.** The capture content script exists only while a session is `active`, is never injected into deny-listed hosts (`excludeMatches`), under `current_tab` is injected only into attached tabs, and is removed at teardown (§9.2); the only permanent content script is the join bridge on our own exact origins. | §9.1, §9.2 |
| P8 | **Two reporters, one chain.** Every action the Assist requests is attested by the extension (the executor, actor `desk`) and reported by the console (the requester, actor `user`), correlated by `opId`; the audit view flags rows present on one side only. | §3.6, §3.7 |

Out of Phase B: Firefox and Safari builds (§9.7 notes only), Android "extension", managed-policy rollout documentation beyond `managed_schema.json`, server-side rrweb recording (the Assist records), supervisor join, co-browsing of cross-origin iframe contents, canvas/WebGL capture, media element capture (`<video>` frames are not mirrored; the element renders as a placeholder).

---

## 2. Token and join flow for P2

Tokens are unchanged (A §3): tier `p2_extension`, `typ` `one_time` or `timed`, created by `POST /api/v1/tokens` (seat tier cap applies). `PublicToken.joinSupported` becomes `true` for `p2_extension` (§11.3).

### 2.1 Join page (`/join`) when `PublicToken.tier === 'p2_extension'`

Replaces A §6.13 step 5 for this tier. Steps 1, 2, 4 and 6 of A §6.13 are unchanged.

| Step | Behaviour |
|---|---|
| J1 | Header as for P1 (org branding, technician or "your technician", expiry countdown) plus the sentence "This session uses the IndiansAssist browser extension. Your technician will see the pages you choose to share, never your whole screen." |
| J2 | **Detection.** On load the page (a) listens for `window.postMessage` events and accepts one only when `event.source === window && event.origin === location.origin` and `event.data` validates against `extPresentSchema` (`{ source: 'ia-ext', t: 'ia.ext.present', version, id }`, sent by the bridge content script, §9.2) or `joinReplySchema` (`ia.join.reply`, §2.2); anything else is ignored silently; and (b) for each id in `PublicToken.extension.ids` calls `chrome.runtime.sendMessage(id, { t: 'ia.ext.ping', v: 1 })` when `globalThis.chrome?.runtime?.sendMessage` exists (Chromium only); the reply is `{ t: 'ia.ext.pong', version, id }` (validated with `extPongSchema`). Either answer marks the extension **detected** (`version`, `id`). `ia.ext.present` is re-sent by the bridge on `visibilitychange`; the page keeps listening. |
| J3 | **Detected:** primary button **Open in extension** (one click): the handshake of §2.2, **no clipboard write** on this path (the token is delivered in-process; PRD 6 calls the clipboard readable by any app, so it is written only when something needs it). On `{ ok: true }` show "Continue in the extension: your technician is being asked to accept. A window will then ask you what to share." plus **Copy token** (explicit button). On `{ ok: false }` the page writes `code` to the clipboard (best effort), shows the error text of §2.2 and the manual fallback of J4. Below the fold: **Copy token** and the dev `<details>` of J5. |
| J4 | **Not detected:** primary button **Install the extension** (PRD 6.5 shape: one click does both): `navigator.clipboard.writeText(code)` best effort, then open `PublicToken.extension.webStoreUrl` (Chrome) or `edgeAddonsUrl` (when `navigator.userAgentData?.brands` contains `Microsoft Edge`) in a new tab, and show "Token copied. After installing, click the IndiansAssist icon in your toolbar and choose Paste from clipboard." When the URL is `null` the button is replaced by "The extension is not yet published; use the developer install below". Always visible: **Copy token** (writes `code`, "Copied" 2 s). The page keeps detecting (J2) and switches to J3 without reload once the extension answers. Web Store URL shape: `https://chromewebstore.google.com/detail/<id>`; Edge: `https://microsoftedge.microsoft.com/addons/detail/<id>`. Until publication the fixtures and docs use the placeholder id `EXTENSION_ID_PLACEHOLDER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'` (shared constant). |
| J5 | `<details>` "Developer install (load unpacked)": `chrome://extensions` -> Developer mode -> Load unpacked -> select `apps/extension/dist`; then reload this page. Shown on every build (it is harmless) but collapsed. |
| J6 | Non-Chromium browser (`!globalThis.chrome?.runtime` and no bridge beacon after 1500 ms, or `navigator.userAgent` contains `Firefox`/`Safari` without `Chrome`): "This package needs Chrome or Microsoft Edge on this computer. Ask your technician for a browser screen-share link instead." plus **Copy token**. |
| J7 | Nothing is written to `sessionStorage['ia.join.token']` for P2; the join page never navigates to `/room/*` for this tier. |

`code` = the compact token or the 12-digit short code the Desk arrived with (same rule as A §6.13 step 3).

### 2.2 Join handshake (join page -> extension)

Two carriers deliver the **same** message; the page uses the first one that answers. The externally_connectable path is the reliable one (works even where content scripts are blocked); the bridge path needs no extension id (unpacked builds with an unlisted id).

| Carrier | Mechanics |
|---|---|
| A: externally_connectable | `chrome.runtime.sendMessage(extensionId, msg)`; manifest `externally_connectable.matches` is the exact-origin list of §9.1 (`REGION_ORIGINS`, no wildcard hosts). The service worker handles `runtime.onMessageExternal`, checks the **full** `sender.origin` (scheme, host, port) against the compiled `REGION_ORIGINS` list **again**, and answers. |
| B: bridge content script | `window.postMessage(msg, location.origin)` from the page; the bridge (`src/content/bridge.ts`, injected only on the §9.1 `web_origins` matches) accepts it when `event.source === window` and `event.origin` is in the compiled `REGION_ORIGINS` list, forwards it to the service worker with `chrome.runtime.sendMessage` (the worker reads the origin from `sender.origin` / `sender.url`, never from the message), and posts the reply back with `window.postMessage({ source: 'ia-ext', t: 'ia.join.reply', ...reply }, event.origin)`. |

```json
{ "t": "ia.join", "v": 1, "code": "ia1.3f9a..." }
```

The message carries nothing else: `signalUrl`, `apiUrl`, `region`, `orgName` and `technicianName` of revision 2 are **gone** (`joinHandshakeSchema` is strict; extra keys => `{ ok: false, error: 'version' }`). The extension derives `apiOrigin = sender origin` (carrier A: `sender.origin`; carrier B: the bridge's `sender.origin`), accepts it only when it is one of the compiled `REGION_ORIGINS` values **exactly** (no wildcard, no host-only compare, no port tolerance), and then calls `POST ${apiOrigin}/api/v1/tokens/public-lookup { code }` (§2.3 header rules, Y21) and uses the server's `signalUrl`, org, technician and tier for everything it displays and connects to. A `421 region_mismatch` with `details.origin` is followed once when `details.origin` is itself in `REGION_ORIGINS` (A R3 rule); any other origin ends in `origin`. The page-supplied origin is therefore only a **selector** among compiled values; the page can never name a server.

For a **compact token** the extension verifies the token locally before any network call: it fetches `${apiOrigin}/.well-known/indiansassist.json` once per `apiOrigin` (cached in `chrome.storage.local['ia.pubkeys'][apiOrigin]` for 24 h), runs shared `checkToken(compact, keys, nowSec)` (`parseToken` + `verifyTokenSignature` + `isTokenTimeValid`, A §3.4-3.5 client subset) and answers `bad_code` on any failure; a 12-digit short code skips this step by nature (the server verifies it in `public-lookup`). PRD 6 "the client verifies the signature" is met for P2.

Reply: `{ ok: true, state: 'connecting' | 'already_connected' }` or `{ ok: false, error: 'busy' | 'bad_code' | 'origin' | 'version' | 'unsupported_tier' }`. `busy` = a session is live on this profile (the page says "Finish the current session first"); `version` = `v` unsupported or unknown keys; `origin` = the sender origin is not in `REGION_ORIGINS` (the service worker also logs it to `ia.diagnostics`); `bad_code` = `normaliseTokenInput(code)` returned `null` or the local signature / expiry check failed; `unsupported_tier` = the lookup answered a tier other than `p2_extension`. Shared exports `joinHandshakeSchema` (`ia.join`), `joinReplySchema`, `extPingSchema` / `extPongSchema` / `extPresentSchema` and `EXT_HANDSHAKE_VERSION = 1` in `extension/handshake.ts`.

### 2.3 Other token entry paths (side panel idle view and popup, §7, §9.6)

| Path | Behaviour |
|---|---|
| Clipboard | Button **Paste from clipboard** (user gesture) **in the side panel**: the panel itself calls `navigator.clipboard.readText()` in the click handler (permission `clipboardRead`; a service worker has no `navigator.clipboard` and an offscreen document cannot read it without focus), runs `normaliseTokenInput`, then sends `ui.connect { code, via: 'clipboard' }`; a `null` result shows "No IndiansAssist code on the clipboard". The extension never reads the clipboard without the click, including on first open (§14 Y17). |
| Manual | Text field "Support code or link" accepting the 12-digit code, the compact token or a full `/join#t=` URL (the UI extracts `t` from fragment or query, A §3.3 rule, same algorithm as `apps/web/src/lib/joinInput.ts`, copied into `src/shared/join-input.ts`). **Connect** sends `ui.connect { code, via: 'manual' }`. |
| API origin for manual / clipboard entry | `chrome.storage.local['ia.apiOrigin']` (options page, a drop-down over the compiled `REGION_ORIGINS` plus the dev origins of a dev build; default `VITE_DEFAULT_API_ORIGIN`, prod `https://indiansassist.com`; free text is **not** accepted). The worker runs the §2.2 local token check, then `POST ${apiOrigin}/api/v1/tokens/public-lookup { code }`; a `421 region_mismatch` with `details.origin` is followed once when `origin` is in `REGION_ORIGINS` (A R3). `signalUrl` comes from the `PublicToken`. A lookup whose `tier !== 'p2_extension'` shows "This code is for a different IndiansAssist package" and connects nothing. |
| Request headers (all extension -> api calls, Y21) | every REST call from the extension (service worker, side panel, popup, options) sends `X-Requested-With: IndiansAssist` (shared `CSRF_HEADER` / `CSRF_HEADER_VALUE`) and carries the browser-set `Origin: chrome-extension://<id>`; `credentials: 'omit'`. The browser does not apply CORS to these calls (extension pages with `host_permissions` for the origin), so the api's CORS plugin stays unchanged; the api's CSRF rule and WS upgrade Origin check are amended by Y21 to accept listed extension origins for exactly `POST /tokens/public-lookup`, `GET /.well-known/indiansassist.json` and the `/signal` upgrade. |

### 2.4 Connecting as a Desk

The extension is a Desk of A §7 with these additions:

| Item | Contract |
|---|---|
| WS upgrade | `new WebSocket(signalUrl)` from the service worker; the upgrade carries `Origin: chrome-extension://<id>` (the browser sets it; the extension cannot add headers to a WebSocket). Server rule Y21: the `/signal` upgrade accepts `Origin` equal to `WEB_ORIGIN` **or** `chrome-extension://<id>` for an id in `EXTENSION_IDS` (dev: any `chrome-extension://` origin when `EXTENSION_IDS` is empty and `NODE_ENV !== 'production'`); anything else is rejected `403` as before. An extension-origin socket may only send Desk messages (`desk.*`, `webrtc.*`, `ping`/`pong`, `session.end`, `chat.message`, `session.stats` is Assist-only); `assist.hello` from such a socket answers `error forbidden` and closes `4403`. |
| `desk.hello` | `{ token, deskLabel?, resumeKey?, client: { kind: 'extension', version: '<package.json version>', browser: { name: 'chrome' \| 'edge' \| 'other', version: '<major>' }, os?: 'windows' \| 'mac' \| 'linux' \| 'cros' \| 'other' } }`. `client` is a new optional field (`deskClientSchema`); absent means `{ kind: 'web' }`. `browser.name` and `browser.version` come from the low-entropy `navigator.userAgentData.brands` (major version only, string, `<= 8` chars), `os` from `navigator.userAgentData.platform` mapped to the enum (`other` when unknown); **high-entropy values are never requested**; every string is limited by `LIMITS.deskClientStringMax` (32). |
| Tier gate (server) | after A §3.5 verification: token tier `p1_browser` requires `client.kind === 'web'`; `p2_extension` requires `client.kind === 'extension'`; otherwise `error join_unsupported { details: { tier, expectedClient } }` and close `4403`. `p3_portable`, `p4_installed` and `typ = enrollment` stay `join_unsupported`. |
| `desk.hello.ok` | unchanged; `tier` tells the extension which flow it is in |
| `deskLabel` | the optional "Your name" field, remembered in `chrome.storage.local['ia.lastDeskLabel']` |
| Poll | `desk.poll` every 3 s while `waiting` / `held` (A §7.3), from the service worker; the side panel shows "Waiting for <technician>" / "Your technician is not online yet; the extension keeps trying" |
| Knock | automatic `desk.knock` right after `desk.hello.ok` (as `/room/new` does) |
| Session row | `session.tier = 'p2_extension'`, `session.desk_client` = the `client` object (§11.1), `desk_user_agent` as before |

---
## 3. Session lifecycle differences

### 3.1 Consent prompt (extension page `consent.html`)

Opened by the service worker **only when `session.created.state === 'consent_pending'`** (a re-sent `session.created` on resume, §3.5, never opens a second window) as a popup window: `chrome.windows.create({ url: 'consent.html?sessionId=<id>', type: 'popup', width: 520, height: 820, focused: true })`. No `chrome.notifications` (no `notifications` permission). **Before** `windows.create` the worker computes the candidate tab with `chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' })`, excluding tabs on our own `web_origins` (the `/join` page) when another normal tab exists, and passes `tabId` to the page in `chrome.storage.session['ia.pending'].candidateTabId`. The window shows (A D1 rules apply where they fit):

| Element | Content |
|---|---|
| Who | accepting technician `session.created.assist.name`, org `displayName` and `logoData`; "wants to see your browser" |
| Scope | radio **This tab only** (default) with a **tab picker** (`chrome.tabs.query({ windowType: 'normal' })`, title and host per row, candidate pre-selected, denied and unsupported tabs listed greyed as "protected" / "cannot be shared") / **All my tabs** (only when `policy.allowAllTabs` and managed `allowAllTabs !== false`); text "Tabs on protected sites are never shared" with a **Which sites?** link listing the deny list hosts (org + built-in + managed `extraDenyList`) |
| Background tabs | checkbox "Allow the technician to open background tabs (you can close them any time)"; default **off** for **This tab only**, **on** for **All my tabs**; hidden and forced off when `!policy.backstageAllowed` or managed `allowBackstage === false` |
| Level | radio **View only** / **Let them switch and open tabs** / **Let them click and type in shared pages** / **Deep control (Chrome will show a debugging bar, and will ask you to allow it every session)**; default `policy.defaultConsentLevel`; levels above `effectiveMaxLevel(policy, managed)` (§5.2) are not rendered. Choosing `deep_control` calls `chrome.permissions.request({ permissions: ['debugger'] })` **on the Share click** (a user gesture) and **before** any WS frame; a refusal downgrades the choice to `in_page` with a notice, so the level sent to the server is always one the extension can honour |
| Masking | "Passwords and fields marked sensitive are hidden from the technician. They can ask you to reveal a field for up to a minute; you decide each time and can hide it again." |
| Checklist | required checkbox "I have closed tabs I do not want to share" (hidden when scope is **This tab only**) |
| Managed limits | when the managed policy (§9.4) lowered any option: "Some options are limited by your organisation's policy." |
| Buttons | **Share** (primary), **Decline**; Escape = Decline; the window closing = Decline |

**Share**: the consent page first calls `chrome.sidePanel.open({ windowId })` for the window of the chosen tab (allowed: it runs in the click handler, a user gesture), then sends `ui.consent { decision: 'share', level, scope, backstage, tabId }` to the service worker, which sends WS `desk.consent { state: 'granted', surface: 'browser', extension: { level, scope, backstage } }` (new optional `extension` object; **required** when the session tier is `p2_extension`, **rejected** with `error bad_payload` for `p1_browser`). Server: validates `levelAtLeast(effectiveMaxLevel(policy), level)` (else `bad_payload`), `scope === 'all_tabs'` only when `policy.allowAllTabs`, `backstage === true` only when `policy.backstageAllowed`, stores `session.consent_level`, `session.consent_scope`, `session.consent_backstage`, writes `session.consent_granted { surface: 'browser', level, scope, backstage }`, then `session.started`, replies `consent.ok` with ICE, mirrors `consent.changed { state: 'granted', surface: 'browser', level, scope, backstage }` to the Assist. Only after `consent.ok` does the offscreen document build the `RTCPeerConnection` (A D2 ordering). **Decline** sends `desk.consent { state: 'revoked' }`.

### 3.2 Level changes during `active`

| Direction | Mechanics |
|---|---|
| Assist asks | control op `level.request { level, reason }` (§5; `reason` **required**, 1..500, for `in_page` and `deep_control`, optional for `tab_control`); the console also writes `level.requested { level, opId }` with the reason (§3.7). The extension shows a prompt in the side panel **and** the top bar of the focused tab ("<technician> asks for: click and type in shared pages. Reason: <reason>", `textContent` only); 60 s without an answer => the op is answered `{ ok: false, error: { code: 'timeout' } }` |
| Desk decides | **Allow**: when the requested level is `deep_control` the side panel first runs `chrome.permissions.request({ permissions: ['debugger'] })` in the click handler; a refusal answers the op `refused` with message `debugger permission refused` and writes nothing else. Otherwise the worker sends WS `desk.consent_level { sessionId, level, requested: true, opId }` and answers the op `{ ok: true, result: { level } }` only after `consent.level_ok`. **Refuse** answers the op `{ ok: false, error: { code: 'refused' } }`. Refuse and timeout both write `desk.event consent.level_refused { from, requested, opId, timeout: boolean }` with the technician's reason in the `reason` column |
| Desk lowers | side panel level selector, same WS message with a lower level (`requested` absent, no `opId`); the extension detaches `chrome.debugger` immediately when leaving `deep_control` and stops honouring input ops when leaving `in_page` (before the WS frame is sent) |
| Server | `active` only (else `error bad_state`); `levelAtLeast(effectiveMaxLevel(policy), level)` (else `bad_payload`); updates `session.consent_level`, writes `consent.level_changed { from, to, requestedBy, opId? }` (`requestedBy` = `'assist'` when `requested: true`, else `'desk'`), replies `consent.level_ok { sessionId, level }`, pushes `consent.changed { state: 'granted', surface: 'browser', level, scope, backstage }` to the Assist |
| Assist | greys/un-greys the input mode toggle (§10) from `consent.changed.level`; never from the op reply alone |
| Permission lifetime | the optional `debugger` permission is removed at session end (`chrome.permissions.remove({ permissions: ['debugger'] })` after the last detach), so every session re-prompts at the browser level; the consent text says so |

### 3.3 Indicators (all mandatory, none configurable off)

| Indicator | Rule |
|---|---|
| Action badge | `chrome.action.setBadgeText({ text: 'ON' })`, background `#15803d` while `active`; `'DBG'` on `#b91c1c` while any tab has `chrome.debugger` attached; `'...'` on `#a16207` while `waiting` / `held` / `knocked` / `consent_pending`; empty when idle. Title "IndiansAssist: sharing with <technician>" plus "(background tab open)" while one exists |
| Action icon | `icons/live-*.png` set while `active`, default icons otherwise |
| Tab bar | every mirrored tab (and every backstage tab) gets a bar injected by the content script: host element `<ia-indicator data-ia-block>` with a **closed** shadow root, inline `style` `position: fixed !important; inset: 0 0 auto 0 !important; height: 36px !important; z-index: 2147483647 !important; display: block !important`, text "Shared with <technician> (<org>)" or "Shared with <technician> (<org>) via server" while the transport is `relay` (§4.6), a red dot plus "Recording" while `recording.state`/`session.recording` says so (A D3 flags), **Pause this tab** / **Resume**, **Stop sharing**, a `DEEP CONTROL` chip while the debugger is attached to this tab, a `REVEALED` chip plus **Hide again** while a reveal (§8.4) is in force on this tab, and the suffix "(+<n> background tab(s))" while any backstage tab exists. The bar is `data-ia-block`, so the replayer shows a 36 px placeholder box in its place. The page is not pushed down (no DOM change outside the host). All text goes in with `textContent`. |
| Bar self-defence | the content script keeps a `MutationObserver` on `document.documentElement` (childList) that re-appends the host when removed and re-applies the host's inline `style` attribute when changed, and once per second checks `host.checkVisibility()` and `getBoundingClientRect()` (height >= 30, top <= 0, in viewport). If the bar cannot be kept visible for 3 consecutive seconds the tab is paused by the extension (`mirror.tab { state: 'paused' }`, `mirror.stopped { reason: 'error', tabId }`, side panel text "Paused: the page hides the sharing bar") and resumes only by the Desk's **Resume** |
| Backstage toast | the first `backstage.enter` of a session shows a 10 s toast in the bar of the Desk's **active** mirrored tab (or the side panel when no mirrored tab is active): "Technician opened a background tab: <host>" with **Close it**; later ones update the `(+n)` suffix |
| Title prefix | `document.title` prefixed `(Shared) ` while mirrored, restored on stop (`policy.titlePrefix`, default `true`; the only optional indicator, and it is additive). The content script observes `<title>` (childList, characterData) and re-applies the prefix after SPA title writes. `TabInfo.title` and `cs.meta.title` are reported **without** the prefix (`stripSharedPrefix`) |
| Debugging infobar | Chrome's own "IndiansAssist started debugging this browser" bar is shown by the platform while attached; the extension never attempts to dismiss it and the consent text warns about it |
| Side panel | shows the live session while `active` (§7), including the `REVEALED` state per tab with **Hide again** |

### 3.4 Consent revoke, pause, stop

"Flush attestations" below = drain the §3.7 outbox (`control.input` aggregates, pending `tab.action` rows) and send `desk.event mirror.stopped { reason }` with session totals, then wait for the last `event.ok` at most 1 s. It always runs **before** the WS frame that ends the session, because A §7.3 closes the Desk socket `4410` right after `session.ended` and nothing sent later is delivered.

| Action | Extension does (in this order) | Server / audit |
|---|---|---|
| **Stop sharing** (bar, side panel) | stop every `record()`, remove bars and restore titles, detach debugger from every tab, close backstage tabs it created (unless the Desk unticked "Close technician's background tabs"), flush attestations (`mirror.stopped { reason: 'ended' }`), send `stop.sharing` on `ia.ctrl`, hard rule 2 teardown in the offscreen document, unregister / un-inject the capture script, `chrome.permissions.remove({ permissions: ['debugger'] })`, WS `session.end`, clear `ia.session`, `ia.pending` and `ia.policyCache` | `ended (desk_stopped)` as A §7.4 |
| **Revoke consent** (side panel menu) | stop every `record()`, remove bars and restore titles, detach debugger, close backstage tabs, flush attestations (`mirror.stopped { reason: 'revoked' }`), `consent.revoked` on `ia.ctrl`, hard rule 2 teardown, unregister / un-inject the capture script, `permissions.remove`, WS `desk.consent { state: 'revoked' }`, clear storage as above (A D5 order: the ctrl message leaves before the channels close) | `ended (consent_revoked)` |
| **Pause this tab** | `record()` stopped for the tab, bar shows "Paused: not shared", `mirror.tab { state: 'paused' }` on `ia.mirror`; input and navigate ops answer `tab_paused` | `desk.event mirror.stopped { reason: 'paused', tabId, batches, bytes }` (that tab's counters) |
| **Resume** | fresh full snapshot, `mirror.tab { state: 'resumed' }` | `desk.event mirror.started { reason: 'resumed', tabId }` |
| **Hide again** (bar, side panel) | ends the reveal on that tab (§8.4), `record.takeFullSnapshot(true)` | `desk.event mask.restored { tabId, scope, durationMs, by: 'desk' }` |
| Last mirrored tab closed | session stays `active`; Assist sees an empty tab strip; `mirror.stopped { reason: 'all_tabs_closed' }`; with scope `current_tab` the Desk may attach another tab from the side panel (**Share this tab too**) | |
| Desk resume (SW restart, WS blip) | `desk.hello` with `resumeKey` and `client` (§3.5) | |

### 3.5 Resume rule for the extension (amends A §7.5, Y2) and peer-connection rebuild (Y23)

For `client.kind === 'extension'` a Desk resume from `active` **keeps `active`** (`session.resumed { side: 'desk', fromState: 'active', toState: 'active' }`): consent is a decision, not a capture track, and nothing was lost by a socket reconnect. The server re-sends `session.created` (real state `active`, with `extension.policy`) to the Desk, then `ice.refresh` to the Desk (fresh TURN credentials), and `desk.reconnected { state: 'active', consentState: 'granted' }` to the Assist.

**The Desk never reuses an `RTCPeerConnection` across a resume.** On `ice.refresh` that follows a resumed `session.created`, the offscreen document closes its old peer connection (whatever its state), creates a new one with the `ice.refresh` servers, re-creates the six channels and sends `webrtc.offer { sessionId, sdp, restart: true }`; every mirrored tab then re-sends a full snapshot (`mirror.started { reason: 'reconnect' }`). The same rebuild runs after the **third failed** A §7.7 media-recovery attempt during `active` (`restart: true` offer on a brand-new PC) while the §4.6 relay carries traffic in between; relay therefore never becomes permanent.

**The Assist** (web, `MirrorConsole` session): on `desk.reconnected { state: 'active' }` it keeps the replayers, the recorder and the tab strip and marks the link `stale` (status chip "Reconnecting"); it does **not** tear down. On a `webrtc.offer` with `restart: true`, or on any `webrtc.offer` while its own `pc.connectionState !== 'connected'`, it closes the old link (hard rule 2 **minus** consent state and the mirror recorder), creates a new `RTCPeerConnection` with the latest ICE servers it holds (from `ice.refresh` or `session.created`), applies the offer, answers, and waits for the snapshot. A `webrtc.offer` without `restart` while its PC is `connected` is ordinary perfect-negotiation renegotiation (voice). The mirror recorder appends `{"meta":{"t":"reconnect"},"rx":<ms>}` and continues. `webrtcOfferSchema` gains `restart?: boolean` (A §7.3 amendment Y23; a web Desk never sets it). The web Desk (`client.kind === 'web'`) keeps the Phase A behaviour (`active -> consent_pending`) and the console keeps its Phase A `desk.reconnected` handling for P1 sessions. State in `chrome.storage.session['ia.session']` (§9.4) makes the resume survive a service-worker restart; the resume grace stays 30 s.

### 3.6 Audit actions written in a P2 session

Phase A entries are unchanged (`session.knock` ... `session.ended`, `file.*`, `chat.relayed`, `recording.*`). New actions are added to shared `AUDIT_ACTIONS` with two schemas each in `audit/actions.ts`: **`deskEventDataSchema(action)` is the wire shape** sent by the extension over `desk.event`, **`assistEventDataSchema(action)` is the wire shape** sent by the console over `POST /sessions/:id/events`, and **`auditDataSchema(action)` is the chain shape** that `insertAuditEntry` validates and hashes. The server maps wire to chain: it replaces `host` with `hostHash = piiHash(org, host)` (never keeps `host` in `data`), copies the rest, and applies the A §5.3 sanitation. The plaintext host is stored once per `(sessionId, hostHash)` in the mutable table `session_host` (§11.1), which the audit read joins for display exactly as `session_file.name` is joined for `nameHash`; erasing the pepper or the row makes the chain unlinkable without touching a chain byte.

| Action | Actor | Written on | Wire `data` (reporter) | Chain `data` |
|---|---|---|---|---|
| `mirror.started` | desk | `desk.event` when mirroring begins, on each tab resume, attach and reconnect | `{ reason: 'consent' \| 'resumed' \| 'attach' \| 'reconnect', scope, level, tabCount, tabId? }` | same |
| `mirror.stopped` | desk | `desk.event` on pause, policy block of a live tab, all tabs closed, snapshot too large, bar hidden (`error`), and once at the end with totals (§3.4) | `{ reason: 'paused' \| 'policy' \| 'all_tabs_closed' \| 'too_large' \| 'ended' \| 'revoked' \| 'error', tabId?, batches, bytes }` (`bytes` = wire bytes sent on `ia.mirror` or relay, compressed; **per tab** for the per-tab reasons `paused`, `policy`, `too_large`, `error`, and **session totals** for `all_tabs_closed`, `ended`, `revoked`) | same |
| `tab.action` | desk | `desk.event` for **every** §5 tab op whose request passed schema validation, including locally refused ones (`ok: false` with `error`), one entry per request (never per tab) | `{ kind: TabActionKind, opId, tabId?, tabIds?: number[] (<= 50), host?, ok: boolean, error?: ControlErrorCode }` | `{ kind, opId, tabId?, tabIds?, hostHash?, ok, error? }` |
| `tab.action` | user | `POST /sessions/:id/events` by the console when it sends the request (§3.7) | `{ kind, opId, tabId?, tabIds?, host? }` | `{ kind, opId, tabId?, tabIds?, hostHash? }` |
| `control.input` | desk | `desk.event`, aggregated per `(tabId, mode)` over a 10 s window, flushed at window end and at session end (§3.4) | `{ mode: 'dom' \| 'debugger', tabId, count, kinds: ('pointer' \| 'key' \| 'scroll' \| 'fill')[], windowMs, refused: number }` | same |
| `control.input` | user | `POST /sessions/:id/events`, same aggregation on the console | `{ mode, tabId, count, kinds, windowMs }` | same |
| `mask.requested` | user | `POST /sessions/:id/events` when the console sends `mask.request`; `reason` column = the typed reason | `{ tabId, scope: 'field' \| 'tab', nodeId?, opId }` | same |
| `mask.override` | desk | `desk.event` when the Desk approved an unmask request; `reason` column = the technician's reason (from the op) | `{ tabId, scope, nodeId?, fieldKind?: FieldKind, outline?: { w, h }, opId, ttlMs }` | same |
| `mask.refused` | desk | `desk.event` on Refuse, timeout or a silent refusal of a non-unmaskable field | `{ tabId, scope, nodeId?, fieldKind?, opId, cause: 'refused' \| 'timeout' \| 'not_unmaskable' \| 'policy' \| 'bad_target' }` (`reason` column = the technician's reason) | same |
| `mask.restored` | desk | `desk.event` when a reveal ends | `{ tabId, scope, durationMs, by: 'desk' \| 'blur' \| 'ttl' \| 'navigation' \| 'pause' \| 'level' \| 'end' }` | same |
| `level.requested` | user | `POST /sessions/:id/events` when the console sends `level.request`; `reason` column | `{ level, opId }` | same |
| `consent.level_refused` | desk | `desk.event` on Refuse or timeout of a `level.request` (and on a `debugger` permission refusal after Allow) | `{ from, requested, opId, timeout: boolean }` (`reason` column = the technician's reason) | same |
| `backstage.enter` | desk | `desk.event` after the hidden tab was created (or the request was refused: `ok: false`) | `{ tabId?, host, opId, ok, error? }` | `{ tabId?, hostHash, opId, ok, error? }` |
| `backstage.enter` | user | `POST /sessions/:id/events` when the console sends it | `{ host, opId }` | `{ hostHash, opId }` |
| `backstage.exit` | desk | `desk.event` when the backstage tab is closed, kept or brought to front | `{ tabId, outcome: 'closed' \| 'kept' \| 'brought_to_front', durationMs, opId? }` (`opId` absent when the Desk closed it) | same |
| `backstage.exit` | user | `POST /sessions/:id/events` when the console sends it | `{ tabId, action: 'close' \| 'keep' \| 'bring_to_front', opId }` | same |
| `consent.level_changed` | desk | server, on `desk.consent_level` | n/a | `{ from, to, requestedBy: 'assist' \| 'desk', opId? }` |
| `consent.backstage_changed` | desk | server, on `desk.consent_backstage` (§6 B1) | n/a | `{ from: boolean, to: boolean }` |
| `mirror.relayed` | system | server, immediately before `session.ended` when any relay frame was carried | n/a | `{ mirrorFrames, mirrorBytes, controlFrames, dropped }` |
| `org.policy_updated` | user | `PATCH /orgs/current/policy/extension` | n/a | `{ fields: string[] }` |
| `recording.deleted` | user / system | `DELETE /recordings/:id` or the retention sweeper (§11.3, Y26) | n/a | `{ recordingId, cause: 'manual' \| 'retention', bytes }` |

`FieldKind = 'input' | 'textarea' | 'select' | 'contenteditable' | 'text'` (`FIELD_KINDS`). `session.consent_granted` gains optional `level`, `scope` and `backstage` (present for P2, absent for P1).

`desk.event` becomes `{ sessionId, action, data, reason? }` with `action` in `file.sent | file.received | mirror.started | mirror.stopped | tab.action | control.input | mask.override | mask.refused | mask.restored | consent.level_refused | backstage.enter | backstage.exit`; `data` is validated with `deskEventDataSchema(action)` (the `file.*` branch stays `fileEventDataSchema` of `schemas/rest-sessions.ts`); the `(direction, fileId)` dedupe applies to `file.*` only; the A §6.12 budget (5 / s, burst 20) is **unchanged** and the extension stays inside it with the outbox of §3.7; non-file actions are accepted only while `active` and until `ended_at + 60 s` (the Desk socket is normally closed by then, which is why §3.4 flushes first); `reason` is accepted for `mask.override`, `mask.refused` and `consent.level_refused` only (sanitised, 500) and `error bad_payload` otherwise. The server answers `event.ok` per frame as in Phase A.

`POST /api/v1/sessions/:id/events` (A §6.8) extends its action union with `tab.action`, `control.input`, `mask.requested`, `level.requested`, `backstage.enter`, `backstage.exit`, body `{ action, data, reason? }` validated with `assistEventDataSchema(action)`, actor `user` (the socket's technician), accepted while `active` and until `ended_at + 60 s`; same role rule as `recording.started`; rate 10 / s burst 30 per session (`429 rate_limited`). Amendment Y24.

### 3.7 Two reporters and the attestation outbox

**Why both report.** Tab, input, backstage and mask actions are requested by the Assist over the data channel, which the server never sees. Phase A made file transfers dual-attested for the same reason (`file.sent`/`file.received` from both sides, `SessionFile.match`); Phase B does the same for every control op: the console reports the request (actor `user`, the technician's own word, through the authenticated REST route) and the extension attests the outcome (actor `desk`, like `file.received`). A console that stops reporting cannot stop the extension, and a modified extension cannot fabricate a request the console never made without the pair showing a gap. Both rows carry the same `opId`.

| Rule | Value |
|---|---|
| Pairing in the audit view (§10.4) | rows are grouped by `(opId)`; a `desk` row without a `user` row is labelled "reported by the Desk only"; a `user` row without a `desk` row (after 15 s or at session end) "reported by the console only"; a matched pair is rendered once as "<technician> requested, performed by the extension" with the outcome from the `desk` row. `GET /sessions/:id/audit` is unchanged; the pairing is a client-side view; the JSONL export carries both rows |
| Console reporting | `controlClient` posts `tab.action` / `backstage.*` / `mask.requested` / `level.requested` **when it sends** the `ctl.req` (not when it gets the answer); `control.input` is aggregated per `(tabId, mode)` over 10 s like the extension's. Failures to post are retried 3 times then surfaced in the audit tab as "N requests not reported"; they never block the op |
| Extension outbox (`src/background/attest-outbox.ts`) | every `desk.event` goes through **one FIFO per session**, drained at **4 / s with a burst of 15** (`LIMITS.deskEventOutboxPerSec`, `LIMITS.deskEventOutboxBurst`; below the server's 5 / s, burst 20); entries are **never dropped**, only delayed; the queue is persisted in `chrome.storage.session['ia.outbox']` so a worker restart loses nothing; `error rate_limited` on a frame re-queues it at the head and halves the drain rate for 10 s; §3.4 flushes the queue before `session.end` (at the drain rate, so a long queue is why the Stop button shows "Finishing..." for up to a few seconds) |
| One entry per request | ops that take `tabIds` (`tabs.close`, `tabs.move`, `tabGroups.create`, `tabGroups.ungroup`) write **one** `tab.action` with `tabIds` (and `closed` is in the op result, not the chain); 50 closes are one frame |
| Unit test | `test/attest-outbox.test.ts`: 50 queued `tab.action` entries produce `<= 15` frames in the first second and all 50 within 10 s; a `rate_limited` reply re-queues without loss; `test/session-machine.test.ts`: `tabs.close` with 50 ids produces exactly one `desk.event` |

---
## 4. Mirroring transport and protocol

### 4.1 rrweb `record()` options (content script, binding)

```ts
const builtinMask = ['[data-ia-sensitive]', '[data-ia-sensitive] *', '[contenteditable]', '[contenteditable] *'];
const builtinBlock = ['[data-ia-block]', 'ia-indicator'];
const maskSelector = [...builtinMask, ...validSelectors(policy.maskSelectors)].join(', ');   // never a trailing ', '
const blockSelector = [...builtinBlock, ...validSelectors(policy.blockSelectors)].join(', ');

record({
  emit, // -> batcher (§4.3)
  recordCanvas: false, inlineImages: false, collectFonts: false, inlineStylesheet: true,
  recordCrossOriginIframes: false,          // cross-origin iframes render as placeholders
  maskAllInputs: true,                      // every <input>, <textarea>, <select> value, including type=text
  maskInputFn: (text, el) => isSecret(el) ? FIXED_MASK : unmaskStore.isUnmasked(el) ? text : '*'.repeat(text.length),
  maskTextSelector: maskSelector,
  maskTextFn: (text, el) => unmaskStore.isUnmasked(el) ? text : FIXED_MASK,
  blockSelector,
  slimDOMOptions: 'all',                    // drops <script>, comments, head meta noise
  sampling: { mousemove: 50, mouseInteraction: { MouseUp: false, MouseDown: false, Click: true, ContextMenu: false, DblClick: true, Focus: true, Blur: true, TouchStart: false, TouchEnd: false }, scroll: 150, media: 800, input: 'last' },
  checkoutEveryNms: 0,                      // snapshots are explicit (§4.4), never periodic
  errorHandler: (e) => bus.send({ to: 'worker', t: 'cs.error', message: String(e).slice(0, 500) }),
});
```

| Rule | Binding detail |
|---|---|
| `FIXED_MASK` | `'********'` (8 chars, shared constant `MASK_FIXED`). Secrets (`isSecret`) and `[data-ia-sensitive]` / `[contenteditable]` text are masked to a **fixed** length so the mask discloses nothing about the value's length; ordinary inputs keep same-length masking for layout fidelity |
| `isSecret(el)` | `el.type === 'password'`, or `autocomplete` in `current-password \| new-password \| cc-number \| cc-csc \| one-time-code`, **or `everPassword.has(el)`**: a `WeakSet` seeded from every `input[type=password]` in the snapshot and from every `attributes` mutation that sets `type` to `password`, so a "show password" eye that flips the type to `text` never unmasks the field for the life of the document. Secrets are **never** unmasked (§8) |
| `[contenteditable]` | masked by default like `[data-ia-sensitive]` (Gmail compose, Slack, Notion, Jira editors are text nodes that `maskAllInputs` does not touch); unmaskable per field (§8.4) |
| `validSelectors(list)` | each org selector is validated **individually** with `document.createDocumentFragment().querySelector(sel)` and `document.documentElement.matches(sel)` in a `try/catch`; an invalid one is skipped and listed in `cs.ready { skippedSelectors }` and `ia.diagnostics`. After joining, the content script runs `document.documentElement.matches(maskSelector)` and `...(blockSelector)` once in `try/catch`; if either throws it falls back to the built-ins alone and reports `selectors_dropped`. One bad selector can therefore never disable the built-in masking |
| `unmaskStore` | holds the elements and the tab-scope reveal approved in §8.4, each with its expiry; `isUnmasked(el)` walks ancestors only up to the approved element (a tab-scope reveal matches every non-secret node) |
| Cross-origin stylesheets | rrweb can inline only same-origin sheets. For each `<link rel=stylesheet>` whose `sheet.cssRules` throws, the content script asks the offscreen document (`cs.fetchCss { url }` -> `oc.css { url, text \| null }`, extension origin with `<all_urls>`, so the fetch is not CORS-bound, `credentials: 'omit'`, 5 s timeout) for the text **once per URL per tab**, caps it at 512 KiB per sheet and 4 MiB per tab (`LIMITS.mirrorCssSheetMaxBytes`, `LIMITS.mirrorCssTabMaxBytes`), strips `@import` and neutralises `url()` per §12.3, and injects it as the `_cssText` of the link node through rrweb's `snapshot` hook (the link stays a `<link>` node with `_cssText`, which the replayer turns into `<style>`). Sheets over the cap or failing to fetch stay unstyled (placeholder note in the console: "Some styles could not be mirrored"). The bytes count against the snapshot budget (§4.3) |
| Snapshot | `record.takeFullSnapshot(true)` is called whenever §4.4 asks for one |
| Where it runs | the top document of a mirrored tab only (never in frames) and only when `isMirrorableUrl(url)` (`http:`/`https:` only) and `!matchesDenyList(url, effectiveDenyList)`. Tabs on other schemes (`chrome://`, `chrome-extension://`, `edge://`, `about:`, `file:`, `devtools://`, `view-source:`, `blob:`, `data:`) are `unsupported`; deny-listed hosts are `denied` (TabInfo, §4.5) |

### 4.2 Channels

Two new data channels join the four of A §8, created by the Desk (offscreen document) before the first offer, `ordered: true`, default reliability, `binaryType = 'arraybuffer'`:

| Label | Direction | Purpose |
|---|---|---|
| `ia.mirror` | Desk -> Assist data; Assist -> Desk acks | rrweb batches and snapshots (binary frames, fragmented per §4.5), tab metadata and acks (JSON text frames) |
| `ia.control` | Assist -> Desk requests; Desk -> Assist replies and events | §5 |

`DATA_CHANNEL_LABELS` becomes `['ia.chat', 'ia.annot', 'ia.file', 'ia.ctrl', 'ia.mirror', 'ia.control']`. A P1 session still creates only the first four; the Assist treats the absence of `ia.mirror` as "P1".

### 4.3 Batching

| Rule | Value |
|---|---|
| Flush trigger | 64 events **or** 200 ms since the first queued event, whichever first; a `FullSnapshot` (rrweb type 2) always flushes alone with its preceding `Meta` (type 4) as a `snapshot` frame |
| Max raw batch | 256 KiB of JSON; a larger queue is split into consecutive batches (each gets its own `seq`) |
| Max raw snapshot | 8 MiB raw (`LIMITS.mirrorSnapshotMaxRawBytes`), and **2 MiB deflated while on relay** (`LIMITS.mirrorRelaySnapshotMaxBytes`); above either the tab becomes `too_large` (`mirror.tab { state: 'too_large', transport }`, `mirror.stopped { reason: 'too_large' }`), `record()` is stopped for that tab and the Assist sees a placeholder ("Too large to mirror" / "Too large to mirror through the server"). A tab that is `too_large` only on relay is retried automatically when the data channel re-opens |
| Compression | `enc = deflate` via `new CompressionStream('deflate')` (zlib wrapper) in the offscreen document when raw > 1 KiB; else `none`; flagged in the frame header; applied to the whole payload **before** fragmentation |
| `seq` | per tab, `0` for every snapshot frame; batches after a snapshot are `1, 2, 3 ...` and **restart at `1` after the next snapshot** |
| Gap handling (Assist) | a batch whose `seq` is not `last + 1` is dropped and **one** `mirror.nack` is sent per tab per 2 s (`LIMITS.mirrorNackIntervalMs`); after sending a nack the Assist **ignores every batch for that tab until the next `snapshot` frame** arrives. The Desk coalesces nacks received within 2 s of sending a snapshot for that tab (no second snapshot) |
| Focused tab | the tab the Assist is viewing (`mirror.focus` op) streams at the rules above |
| Focus ownership | **Focus is owned by the Assist.** The extension changes the focused tab only on `mirror.focus`; a default focus is set once at `consent.ok` (the consented tab under `current_tab`, the Desk's active tab under `all_tabs`). On `tabs.onActivated` the extension only sends `mirror.tabs` with the new `activeTabId`; the console shows a chip "User switched to <title>" with **Follow**, which sends `mirror.focus` |
| Unfocused mirrored tabs | events are **buffered locally** (per-tab cap 2 MiB raw) and flushed only when the tab becomes focused; on overflow the buffer is dropped and a fresh snapshot is scheduled for the next focus. Nothing is sent for them except `mirror.tab` metadata changes (title, url, favicon, audible, status) |
| Mouse moves | emitted by rrweb at 50 ms sampling; the batcher additionally drops a `MouseMove` incremental event when another one is queued behind it in the same batch |

### 4.4 Snapshots

A full snapshot (`snapshot` frame) is sent: on attach (consent, tab added, navigation commit in a mirrored tab, `document_start` of a new document), on `mirror.focus` when the tab's last snapshot predates a buffer drop, on `mirror.nack` (coalesced, §4.3), on the `mirror.snapshot` op, on a reveal start or end (§8.4), on data-channel re-open after a transport switch (§4.6), after a peer-connection rebuild (§3.5) and on §4.5 stall recovery. A snapshot for a tab that is not focused is deferred until focus. Replace rule on the Assist: a `snapshot` frame for a tab resets that tab's replayer (new `Replayer` instance, §10.2).

### 4.5 Frames on `ia.mirror`

Chrome-to-Chrome SCTP data channels deliver at most `RTCSctpTransport.maxMessageSize` bytes per message (262144 today; `dc.send()` of a larger buffer throws and nothing is delivered), so every binary frame is **fragmented**. Binary frame layout (`packages/shared/src/extension/mirror-frame.ts`: `encodeMirrorFrames`, `decodeMirrorFrame`, `MirrorReassembler`, `MIRROR_FRAME_VERSION = 2`):

| Bytes | Field |
|---|---|
| `[0]` | version `2` |
| `[1]` | kind: `1` batch, `2` snapshot |
| `[2]` | flags: bit 0 = deflate |
| `[3]` | reserved `0` |
| `[4,8)` | uint32 BE `tabId` |
| `[8,12)` | uint32 BE `seq` |
| `[12,14)` | uint16 BE `part` (1-based) |
| `[14,16)` | uint16 BE `parts` (`>= 1`, `<= 256`, `LIMITS.mirrorDcMaxParts`) |
| `[16,20)` | uint32 BE raw payload length (after inflation; the receiver refuses messages whose declared length exceeds 8 MiB, and stops inflating past it) |
| `[20,n)` | one chunk of the payload: UTF-8 JSON **array** of rrweb `eventWithTime` objects, deflated when flagged, split into chunks of `chunkBytes = min(pc.sctp?.maxMessageSize ?? 65536, LIMITS.mirrorDcChunkBytes) - 20` bytes |

`encodeMirrorFrames({ kind, tabId, seq, rawLength, payload, deflate, chunkBytes }): ArrayBuffer[]` returns the parts in order; the sender sends them back to back under the backpressure rule below (each chunk is one `dc.send`). The receiver's `MirrorReassembler` keys on `(tabId, kind, seq)`, accepts parts in any order, and completes when all `parts` arrived; a message with a part missing for 2 s (`LIMITS.mirrorReassembleTimeoutMs`) is discarded and treated as a gap (§4.3 nack rule). `LIMITS.mirrorDcChunkBytes = 65536`. The same codec (without the per-frame `[12,16)` fragmentation, since the WS carries `part`/`parts` in JSON) is **not** reused for relay: relay slices the §4.5 payload itself (§4.6).

JSON text frames on `ia.mirror` (`schemas/datachannel.ts`):

| `t` | Dir | Shape |
|---|---|---|
| `mirror.tabs` | D -> A | `{ t: 'mirror.tabs', tabs: TabInfo[], hiddenCount, activeTabId, focusedTabId, ts }` sent when the channel opens and after every change (debounced 250 ms) |
| `mirror.tab` | D -> A | `{ t: 'mirror.tab', tab: TabInfo, state: 'attached' \| 'detached' \| 'paused' \| 'resumed' \| 'denied' \| 'too_large' \| 'navigated' \| 'revealed' \| 'restored', transport?: 'dc' \| 'relay', ts }` |
| `mirror.ack` | A -> D | `{ t: 'mirror.ack', tabId, seq, ts }` every 2 s per tab while frames arrive, and immediately after a snapshot was applied |
| `mirror.nack` | A -> D | `{ t: 'mirror.nack', tabId, seq, ts }` a gap, a reassembly timeout or a decode error; the Desk answers with a snapshot (coalesced, §4.3) |

`TabInfo = { tabId, windowId, index, title: string | null, url: string | null, favicon: string | null, active, pinned, muted, audible, groupId, status: 'loading' | 'complete', mirrored: 'yes' | 'paused' | 'denied' | 'too_large' | 'not_in_scope' | 'unsupported', backstage: boolean, createdByAssist: boolean, revealed: 'none' | 'field' | 'tab', discarded: boolean, error?: 'inject_failed' }`. For `denied` and `not_in_scope` tabs `title`, `url` and `favicon` are `null` (never the host). `unsupported` tabs carry `title` and `url` (for example `chrome://settings`) and `favicon: null`. `url` is `stripUrlForMirror(url)` = origin + path only (no query, no fragment, no credentials; shared, also used for `Meta.href`, §12.3). `title` has the `(Shared) ` prefix stripped. **`favicon` is strictly a `data:image/*` URL of at most 8 KiB or `null`** (`tabInfoSchema`: `z.string().startsWith('data:image/').max(11000).nullable()`): the service worker fetches `tab.favIconUrl` itself (it has `<all_urls>`; `credentials: 'omit'`, 3 s timeout, 8 KiB cap, once per URL per session) and inlines it; the console never fetches anything for a favicon and renders a letter avatar for `null`. With scope `current_tab`, `tabs` lists only mirrored, Assist-created and backstage tabs and `hiddenCount` carries the rest.

Backpressure (Desk side, per channel): stop sending when `bufferedAmount > 1 MiB`; resume at `bufferedAmountLowThreshold = 256 KiB`; the check runs **per chunk**; if stalled for 3 s, drop the queued batches for the focused tab and schedule a snapshot for when the channel drains (a stall writes no audit entry). Ack-based: if no `mirror.ack` for 10 s while frames were sent, treat the channel as stalled (same recovery). A focused tab whose snapshot is pending while the channel is above the pause threshold waits; batches for other tabs are never queued (§4.3).

### 4.6 WS relay fallback (declared E2EE gap, Y22)

Used only while `ia.mirror` / `ia.control` is not open 5 s after `consent.ok`, or after it closes mid-session until it re-opens (and during the §3.5 rebuild). A transport switch is announced by a fresh snapshot of the focused tab on the new transport; the Assist reflects it in `session.stats.mirrorTransport` and the status chip, the Desk's tab bars read "... via server" (§3.3). Both directions are relayed by the server after the A §7.2 session authorisation, never logged (`*.data`, `*.msg` redacted), never persisted. **The relay carries the Desk's DOM and the technician's input in plaintext (deflate + base64url is not encryption) through the signaling server; this is a PRD §7 deviation recorded as Y22**, and an org may refuse it: `policy.allowRelayFallback` (default `true`); when `false` the server answers every `mirror.relay` / `control.relay` with `error bad_state`, the clients never attempt it, the console shows "This organisation does not allow server relay; waiting for a direct connection", and after the §3.5 rebuild still fails the session may be ended by either side. The residency report lists `allowRelayFallback` and the relay counters.

| Message | Dir | Shape | Limits |
|---|---|---|---|
| `mirror.relay` | D -> S -> A (data), A -> S -> D (acks / nacks only) | `{ t: 'mirror.relay', sessionId, tabId, seq, kind: 'batch' \| 'snapshot' \| 'json', enc: 'none' \| 'deflate', part, parts, data }`; `data` = base64url of a slice of the (deflated) payload, or of the JSON text for `kind: 'json'`; `part` 1-based. **For `kind: 'json'`: `tabId = 0`, `seq = 0`, `enc = 'none'`, `part = parts = 1`** (`mirrorRelaySchema` refinement) | `data` <= 40960 chars (30 KiB raw) so the frame stays under the 64 KiB A §7.1 limit; `parts <= 256`; counts against the per-connection bucket (20 frames / s, burst 60); **per-session mirror budget 512 KiB of `data` per sliding 10 s** (`MIRROR_RELAY_BUDGET_BYTES`, about 400 kbps) is a **pacing contract**: the Desk tracks its own spend against `LIMITS.mirrorRelayBudgetBytes` and delays parts until the window frees (a snapshot may span windows); the server still drops violations with `error rate_limited { details: { retryAfterSec } }` and counts them in `mirror.relayed.dropped`; accepted only while `active` and only for `tier = 'p2_extension'` with `policy.allowRelayFallback` (`error bad_state` otherwise). **Direction rule:** from the Assist socket only `kind: 'json'` is accepted (`error bad_payload` for `batch` / `snapshot`) |
| `control.relay` | A -> S -> D (requests), D -> S -> A (replies, events) | `{ t: 'control.relay', sessionId, msg: ControlMessage }` | JSON of `msg` <= 16 KiB (`error payload_too_large`); 10 / s per session per direction (`error rate_limited`); pointer and key ops over relay are coalesced by the Assist to 5 / s. **Direction rule:** from an Assist socket `msg.t` must be `ctl.req`, from a Desk socket `ctl.res` or `ctl.event`; otherwise `error bad_payload` |

| Rule | Value |
|---|---|
| Server | does not reassemble parts; forwards each frame to the other participant unchanged; increments per-session counters (`mirrorFrames`, `mirrorBytes` = sum of `data` lengths, `controlFrames`, `dropped`) kept on the session's live registry (owner node; routed like `chat.relayed` on multi-node) and writes `mirror.relayed` before `session.ended` when any is non-zero |
| Frame bucket exemptions (Y25) | `ping`, `pong`, `session.end` and `desk.consent` never consume the A §6.12 connection bucket, so a Desk pacing relay frames at the bucket limit is never closed `4408` for a missed heartbeat |
| Client validation | both clients validate every relayed `msg` with `controlMessageSchema` (strict) and **drop wrong-direction messages** (a `ctl.req` arriving at the Assist, a `ctl.res` arriving at the Desk) |
| De-duplication | the extension de-duplicates `ctl.req` by `id` for 30 s (a request sent over relay and again over the re-opened channel executes once); the Assist de-duplicates `ctl.res` / `ctl.event` by `(id)` / `(kind, ts)` likewise |
| Console | shows "Relayed through the server (degraded, not end-to-end encrypted)" while on relay and the network panel shows the budget use |

### 4.7 Optional mirror recording (Assist side)

The server never records mirror data. When the technician presses **Record** in a P2 console (or `policy.recordMirror` auto-starts it at `active`): the console appends every received event to an in-memory JSONL buffer, `recording.started` is reported as in Phase A (`POST /sessions/:id/events`, Desk bar dot via `recording.state` and `session.recording`), and on stop or session end the buffer is gzipped with `new CompressionStream('gzip')` and uploaded through the existing recordings endpoints (A §6.10, single or chunked) with `mime: 'application/x-ia-rrweb+jsonl'`:

| Line | Content |
|---|---|
| 1 | `{"ia_rrweb":1,"sessionId":"<uuid>","assist":{"id":"<uuid>","name":"<name>"},"startedAt":"<ISO>","rrweb":"<version>","tabs":[TabInfo...]}` (the `assist` object is the forensic binding; the whole file is covered by the sha256 in the chain) |
| 2.. | `{"tabId":12,"seq":3,"rx":1761220000123,"e":{...rrweb eventWithTime, sanitised per §12.3, Meta.href stripped...}}`, `{"tabId":12,"meta":{...mirror.tab / mirror.tabs message...},"rx":...}` and `{"meta":{"t":"reconnect"},"rx":...}` lines, in receive order |
| Revealed values | while a reveal (§8.4) is in force on a tab and `policy.recordRevealed` is `false` (default), the recorder **drops** that tab's `IncrementalSnapshot` events with `source` `5` (Input) and the `texts` entries of `source` `0` (Mutation) and writes one `{"tabId","redacted":{"scope","from","to"},"rx"}` line per reveal instead; the live view is unaffected. With `recordRevealed: true` the events are kept and the unmask prompt said so (§8.4) |

Server: `RECORDING_MEDIA_TYPES` gains `application/x-ia-rrweb+jsonl` (no `codecs` parameter allowed; `RECORDING_MIME_RE` extended), `recordingFileExtension` returns `jsonl.gz` for it; storage key suffix `.jsonl.gz`; download `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="<id>.jsonl.gz"`, all A §6.10 SEC-01 headers; sha256 into the chain exactly as video (`recording.stored`). One recording per session still holds (A unique `recording.session_id`). After the session the console offers **Replay** (§10.5). Voice is not part of the mirror recording in Phase B (noted in the console). Retention and deletion: §11.3 (Y26).

---

## 5. Browser control protocol (`ia.control`)

### 5.1 Envelope

| `t` | Dir | Shape |
|---|---|---|
| `ctl.req` | A -> D | `{ t: 'ctl.req', id: string (<= 40 chars, unique per session), op: ControlOp, args: object, ts }` |
| `ctl.res` | D -> A | `{ t: 'ctl.res', id, ok: true, result: object, ts }` or `{ t: 'ctl.res', id, ok: false, error: { code: ControlErrorCode, message: string (<= 200) }, ts }` |
| `ctl.event` | D -> A | `controlEventSchema = z.discriminatedUnion('kind', [...])` over the five rows below; every row carries `t: 'ctl.event'`, `kind`, `ts` |

| `ctl.event.kind` | Fields | When |
|---|---|---|
| `level` | `{ level: ConsentLevel, scope: MirrorScope, backstage: boolean }` | after any level, scope or backstage-consent change and once when `ia.control` opens |
| `debugger` | `{ tabId, attached: boolean, cause?: 'request' \| 'level' \| 'navigation' \| 'pause' \| 'user' \| 'close' }` | attach / detach |
| `paused` | `{ tabId, paused: boolean }` | Desk pause / resume |
| `backstage` | `{ tabId, state: 'opened' \| 'closed' \| 'front' }` | §6 |
| `prompt` | `{ id: string, promptKind: 'level' \| 'mask' \| 'attach', state: 'shown' \| 'answered', opId }` | a prompt card opened / closed on the Desk (`id` = the `ctl.req.id` that caused it) |

Shared (`extension/control.ts`): `CONTROL_OPS` const tuple, `controlRequestSchema` (discriminated on `op`, strict args), `controlResponseSchema`, `controlEventSchema`, `controlMessageSchema`, `ControlMessage` union, `minLevelFor(op): ConsentLevel`, `CONTROL_ERROR_CODES = ['not_allowed', 'denied_url', 'no_such_tab', 'tab_paused', 'not_supported', 'not_in_scope', 'debugger_unavailable', 'refused', 'timeout', 'rate_limited', 'bad_args', 'internal']`. Every request gets exactly one response; the Assist times out after 10 s (`level.request`, `mask.request` and `mirror.attach` after 65 s: the Desk's 60 s prompt plus slack) and treats it as `{ code: 'timeout' }`.

**Op rate at the extension: two buckets.** `input.pointer { kind: 'move' }` has its own bucket of 30 / s (a newer move replaces an unsent older one; moves never consume the general bucket); **every other op** shares a bucket of 30 / s with a burst of 60 (`LIMITS.controlOpsPerSec`, `LIMITS.controlOpsBurst`, `LIMITS.pointerMovesPerSec`); excess => `rate_limited`.

### 5.2 Consent levels and the permission model

`CONSENT_LEVELS = ['view', 'tab_control', 'in_page', 'deep_control']` (ordered; `CONSENT_LEVEL_ORDER` 0..3; `levelAtLeast(a, b)`). `effectiveMaxLevel(policy, managed?)` (shared `extension/policy.ts`) = the lowest of `policy.maxConsentLevel`, `in_page` when `!policy.allowDeepControl`, and the managed caps of §9.4 (`maxConsentLevel`, `allowDeepControl`); it is the **single** rule used by the server (the server knows no managed policy, so it evaluates it with `managed = undefined`), the consent page, the side-panel selector and the console toggle (which reads the server's view through `consent.changed`). The extension sends `desk.consent` / `desk.consent_level` only with a level it can actually honour: a `deep_control` choice first runs `chrome.permissions.request` on the gesture (§3.1, §3.2) and a refusal downgrades to `in_page` **before** the WS frame, so `ctl.event level` always equals the chain.

The extension evaluates **every** op against the current level, the tab's `mirrored` state, the deny list and the policy before executing: `not_allowed` when `levelOrder(current) < levelOrder(minLevelFor(op))`, or for backstage ops when `consent.backstage` is `false`; `denied_url` for ops that touch a `denied` tab's content or navigation, or navigate to a denied host; `tab_paused` for input and navigation on a paused tab; `not_in_scope` for a tab outside `current_tab` scope; `not_supported` for an `unsupported` tab's content ops and for input whose target is a frame (§5.4); `debugger_unavailable` when `input.mode debugger` is requested and the permission or attach fails.

**`assertNavigableUrl(url)`** (`src/background/tabs-control.ts`, one function used by `tabs.create`, `tabs.navigate`, `backstage.enter`, and `tabs.reload` when the tab's current URL is denied): `new URL(url)` normalisation (throws => `bad_args`), `isMirrorableUrl` (`http:`/`https:` only, else `bad_args`: `chrome://`, `file:`, `view-source:`, `javascript:`, `chrome-extension://`, `about:` never reach Chrome), then `!matchesDenyList` on the final host (else `denied_url`). The schema level already rejects non-`http(s)` URLs with `bad_args` (`controlRequestSchema` `url` fields use `z.string().url().refine(isMirrorableUrl)`). Redirects after navigation are caught by the content script's deny check at `document_start` (`mirror.stopped { reason: 'policy' }`, tab becomes `denied`).

### 5.3 Op catalogue

`TabActionKind` (`TAB_ACTION_KINDS`) = the op name for every op whose audit column says `tab.action`. Every row's audit is written by **both** reporters (§3.7) with the same `opId`.

| `op` | `args` | `result` | Min level | Audit |
|---|---|---|---|---|
| `tabs.list` | `{}` | `{ tabs: TabInfo[], hiddenCount, activeTabId, focusedTabId }` | `view` | none |
| `tabs.query` | `{ windowId?, groupId?, active?, pinned?, audible?, urlHost? }` | `{ tabs, hiddenCount }`: the candidate set is **first** reduced to tabs whose `mirrored` is `yes`, `paused` or `too_large` (never `denied`, `not_in_scope`, `unsupported`), **then** filtered; `hiddenCount` = tabs excluded before filtering. `urlHost` can therefore never confirm a protected tab | `view` | none |
| `tabs.activate` | `{ tabId }` | `{ tab }` (`chrome.tabs.update(tabId, { active: true })` + `chrome.windows.update(windowId, { focused: true })`) | `tab_control` | `tab.action` |
| `tabs.create` | `{ url?, windowId?, index?, pinned? }` (always `active: true`; a background tab is `backstage.enter`); `url` through `assertNavigableUrl` (absent = the new-tab page, which is `unsupported` and not mirrored). The created tab is **mirrored under either scope** and marked `createdByAssist: true`; a tab the Assist navigated into existence by other means is not | `{ tab }` | `tab_control` | `tab.action { host }` |
| `tabs.close` | `{ tabIds: number[] }` (1..50) | `{ closed: number[] }` | `tab_control` | **one** `tab.action { tabIds }` |
| `tabs.reload` | `{ tabId, bypassCache? }` | `{}` (`assertNavigableUrl` on the tab's current URL) | `tab_control` | `tab.action` |
| `tabs.navigate` | `{ tabId, url }` | `{ tab }` (`assertNavigableUrl`: `bad_args` / `denied_url`) | `tab_control` | `tab.action { host }` |
| `tabs.pin` | `{ tabId, pinned }` | `{ tab }` | `tab_control` | `tab.action` |
| `tabs.mute` | `{ tabId, muted }` | `{ tab }` | `tab_control` | `tab.action` |
| `tabs.move` | `{ tabIds, index, windowId? }` | `{ tabs }` | `tab_control` | one `tab.action { tabIds }` |
| `tabGroups.list` | `{ windowId? }` | `{ groups: GroupInfo[] }` | `view` | none |
| `tabGroups.create` | `{ tabIds, title?, color? }` (`chrome.tabs.group` + `tabGroups.update`) | `{ group }` | `tab_control` | one `tab.action { tabIds }` |
| `tabGroups.update` | `{ groupId, title?, color?, collapsed? }` | `{ group }` | `tab_control` | `tab.action` |
| `tabGroups.move` | `{ groupId, index, windowId? }` | `{ group }` | `tab_control` | `tab.action` |
| `tabGroups.collapse` | `{ groupId, collapsed }` | `{ group }` | `tab_control` | `tab.action` |
| `tabGroups.ungroup` | `{ tabIds }` | `{}` | `tab_control` | one `tab.action { tabIds }` |
| `windows.list` | `{}` | `{ windows: WindowInfo[] }` | `view` | none |
| `mirror.focus` | `{ tabId }` | `{}` | `view` | none |
| `mirror.snapshot` | `{ tabId }` | `{}` | `view` | none |
| `mirror.attach` | `{ tabId, reason (1..500) }` | `{ attached: boolean }`. Under `all_tabs` a supported tab is already mirrored: answers `{ attached: true }` at once. Under `current_tab` it is a **request**: the Desk sees a prompt (same card as `level.request`, `promptKind: 'attach'`, "<technician> asks to also see the tab <title> (<host>). Reason: ...", **Share it** / **Refuse**, 60 s => `timeout`); approval attaches the tab (`mirror.started { reason: 'attach' }`), refusal answers `refused`. Denied / unsupported targets answer `denied_url` / `not_supported` without a prompt | `view` | `mirror.started { reason: 'attach' }` on approval |
| `input.pointer` | `{ tabId, kind: 'move' \| 'down' \| 'up' \| 'click' \| 'dblclick' \| 'contextmenu' \| 'wheel', nodeId: number \| null, nx?, ny?, vx, vy, button?: 0 \| 1 \| 2 (default 0), modifiers: Modifiers, deltaX?, deltaY? }` (`nx`/`ny` required when `nodeId` is a number, ignored otherwise) | `{}` | `in_page` | `control.input` |
| `input.key` | `{ tabId, kind: 'down' \| 'up' \| 'press', key, code, modifiers, text? }` | `{}` | `in_page` | `control.input` |
| `input.scroll` | `{ tabId, nodeId: number \| null, dx, dy }` (CSS px) | `{}` | `in_page` | `control.input` |
| `input.fill` | `{ tabId, nodeId, value (<= 4000), commit: boolean }` | `{ applied: boolean }` | `in_page` | `control.input { kinds: ['fill'] }` |
| `input.mode` | `{ tabId, mode: 'dom' \| 'debugger' }` | `{ mode }` | `deep_control` for `debugger`; `in_page` for `dom` | `ctl.event debugger` |
| `level.request` | `{ level, reason? }` (`reason` **required** 1..500 when `level` is `in_page` or `deep_control`; schema refinement) | `{ level }` (the level now in force, after the Desk decided) | `view` | user `level.requested`; server `consent.level_changed` or desk `consent.level_refused` |
| `mask.request` | `{ tabId, scope: 'field' \| 'tab', nodeId?, reason (1..500) }` (`nodeId` required for `field`) | `{ granted: boolean, ttlMs? }` | `view` | user `mask.requested`; desk `mask.override` or `mask.refused` |
| `backstage.enter` | `{ url, windowId? }` (`assertNavigableUrl`) | `{ tabId }` | `tab_control`, `policy.backstageAllowed` **and `consent.backstage === true`** (else `not_allowed`) | `backstage.enter` (both reporters) |
| `backstage.exit` | `{ tabId, action: 'close' \| 'keep' \| 'bring_to_front' }` | `{}` | `tab_control` | `backstage.exit` (both reporters) |

`Modifiers = { alt, ctrl, meta, shift }` booleans. `GroupInfo = { groupId, windowId, title, color, collapsed, tabIds }`. `WindowInfo = { windowId, focused, state, type, tabCount, incognito: false }` (incognito windows are never listed; the extension is `incognito: 'not_allowed'`). Denied tabs accept `tabs.activate`, `tabs.close`, `tabs.pin`, `tabs.mute`, `tabs.move` and group ops (no content is touched) and refuse the rest with `denied_url`. Unknown `op` => `not_supported`; args failing the schema => `bad_args` (still attested as `tab.action { ok: false, error: 'bad_args' }` when the `op` is a `TabActionKind`).

### 5.4 Input replay

| Mode | Mechanics |
|---|---|
| Coordinate resolution (both modes) | content script: `el = mirror.getNode(nodeId)` (rrweb record mirror); if it is a connected `Element`, `r = el.getBoundingClientRect()`, `cx = r.left + nx * r.width`, `cy = r.top + ny * r.height`; else `cx = vx * innerWidth`, `cy = vy * innerHeight`. Coordinates are CSS px in the tab's viewport. **Frame rule (both modes):** the content script resolves `hit = document.elementFromPoint(cx, cy)` (descending into open shadow roots); when `hit` is an `<iframe>`, `<frame>`, `<object>`, `<embed>` or `<portal>`, or `hit` is `null` while a frame element contains the point, the op answers `not_supported` with message `cross-origin frame` and **nothing is forwarded to CDP**: input never lands in content the Assist cannot see (card iframes, SSO popups embedded as frames, one-tap widgets). The console shows "This area is an embedded frame and cannot be controlled" |
| `dom` (default) | target = the `hit` element above; `move` dispatches `pointermove` + `mousemove`; `down`/`up` dispatch `pointerdown`/`mousedown` and `pointerup`/`mouseup`; `click` dispatches down, up, then calls `target.click()` and `target.focus({ preventScroll: true })` when focusable; `dblclick` adds `dblclick`; `contextmenu` dispatches `contextmenu`; `wheel` dispatches `WheelEvent` and scrolls the nearest scrollable ancestor by `deltaX/deltaY`; all events `bubbles: true, cancelable: true, composed: true` (`isTrusted` is `false` by nature). `input.key`: `KeyboardEvent` on `document.activeElement`; for `press` with `text` into an editable element the value is inserted with `document.execCommand('insertText', false, text)` and, when that returns `false`, by setting the value through the prototype setter (`HTMLInputElement.prototype.value` / `HTMLTextAreaElement.prototype.value`) followed by `input` and `change` events, so frameworks see the change. `input.fill`: same setter path, `commit: true` also dispatches `change` and `blur`. `input.scroll`: `el.scrollBy(dx, dy)` or `window.scrollBy`. Limits of `dom` mode are shown in the console tooltip ("some sites ignore synthetic input; ask for deep control") |
| `debugger` | service worker: `chrome.debugger.attach({ tabId }, '1.3')` once per tab on `input.mode debugger` (after the level check). **CDP allow-list (binding):** `CDP_ALLOWED_METHODS = ['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText'] as const` in `src/background/debugger-control.ts`; one wrapper `sendCommand(tabId, method, params)` refuses any other method with a thrown `Error('cdp_method_not_allowed')` **before** calling Chrome, and it is the only place in `apps/extension` that may call `chrome.debugger.sendCommand` (ESLint `no-restricted-properties` on `chrome.debugger.sendCommand` outside that file; unit test `test/debugger-control.test.ts` asserts `Runtime.evaluate`, `Network.getCookies`, `Page.navigate`, `Target.attachToTarget`, `Page.captureScreenshot` all throw and never reach the mock). Calls: `Input.dispatchMouseEvent { type: mouseMoved \| mousePressed \| mouseReleased \| mouseWheel, x: cx, y: cy, button, clickCount, modifiers, deltaX, deltaY }`, `Input.dispatchKeyEvent { type: keyDown \| keyUp \| char, key, code, text, modifiers, windowsVirtualKeyCode }`, `Input.insertText` for `press` with `text`; the content script still resolves coordinates and the frame rule (row 1) and returns them to the service worker (`cs.input` reply `{ ok, cx, cy }` or `{ ok: false, error: 'not_supported' }`). Detach on: level drop below `deep_control`, tab navigation to a denied host, tab close, pause, session end, `chrome.debugger.onDetach` (user cancelled the infobar => `ctl.event debugger { attached: false, cause: 'user' }` and the mode falls back to `dom`). While attached the badge is `DBG` and the tab bar shows the chip (§3.3) |
| Coalescing (Assist) | pointer moves at most 30 / s, wheel 20 / s, key events unthrottled; moves are dropped while a `ctl.req` move is unanswered for > 300 ms |

---

## 6. Backstage

| # | Rule |
|---|---|
| B1 | Requires `tab_control` or higher, `policy.backstageAllowed` (default `true`), managed `allowBackstage !== false`, **and the Desk's consent** `extension.backstage === true` (§3.1 checkbox, default off under `current_tab`, on under `all_tabs`; changeable in the side panel while `active`, which sends `desk.consent_level`-style WS `desk.consent_backstage { sessionId, backstage }`, server writes `consent.backstage_changed { to }`, pushes `consent.changed`). Without it `backstage.enter` answers `not_allowed` with message `background tabs not allowed by the user`. A backstage tab is mirrored under either scope (the Assist created it and the Desk sees it listed) |
| B2 | `backstage.enter { url }`: `assertNavigableUrl(url)` (`bad_args` / `denied_url`, §5.2), then `chrome.tabs.create({ url, active: false, windowId })` (never `active: true`, never `windows.update({ focused })`); the tab is marked `backstage: true, createdByAssist: true`, mirrored, gets the indicator bar (text "Technician's background tab, shared with <technician>"), appears in the side panel tab list as "Background tab opened by <technician>: <host>" with **Close**; the §3.3 backstage toast is shown in the Desk's active tab (first one: 10 s with **Close it**); audit `backstage.enter` (both reporters, `host` on the wire); `ctl.event backstage { state: 'opened' }` |
| B3 | While a backstage tab exists the action badge title adds "(background tab open)", every bar carries "(+<n> background tab(s))" and the side panel shows a persistent "<n> background tab(s)" chip with **Close all** |
| B4 | On a backstage tab the Assist may `tabs.navigate`, `tabs.reload`, `input.*` (per level), `mirror.focus`; it must not `tabs.activate` it: the extension answers `not_allowed` for `tabs.activate` on a backstage tab; the only way to the foreground is `backstage.exit { action: 'bring_to_front' }`, which the console labels **Bring to front** and confirms |
| B5 | Chrome throttles background tabs (timers, rendering); `input.pointer` in `dom` mode still works since dispatch is synchronous; `debugger` mode works in background tabs; the console warns that visual updates from a background tab may lag |
| B6 | `backstage.exit`: `close` => `chrome.tabs.remove`; `keep` => the tab stays open, loses `backstage: true` (becomes an ordinary mirrored tab, `createdByAssist` stays `true`); `bring_to_front` => `tabs.update({ active: true })` + `windows.update({ focused: true })`, then as `keep`. Audit `backstage.exit { outcome, durationMs, opId }`. At session end every remaining backstage tab is closed unless the Desk unticked "Close technician's background tabs" in the side panel Stop dialog (`kept`) |
| B7 | The Desk can close a backstage tab at any time (toast **Close it**, side panel **Close** / **Close all**, or the tab's own close button); the extension reports `backstage.exit { outcome: 'closed' }` (no `opId`) and `ctl.event backstage { state: 'closed' }` |

---
## 7. Side panel

`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` at install; `chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true })`. Clicking the action icon opens the side panel in every state; the panel hosts the token entry (§2.3) when idle and the session when live. `default_popup` is unset; `popup.html` (§9.6) is a standalone window for the join handshake when no panel is open.

| Section | Content | Reuses |
|---|---|---|
| Header | org logo/name, technician name, live timer, level chip (`View only` ...), scope chip, background-tabs chip (on/off, toggle), transport chip (`direct` / `relayed (via server)`), **Stop sharing** (red, >= 44 px, always visible), overflow menu: Revoke consent, Change what they can do (level selector, capped by `effectiveMaxLevel`), Open options | A D3 wording |
| Tabs | mirrored tabs list with pause/resume per tab, `REVEALED` state with **Hide again**, **Share this tab too** under `current_tab`, Assist-created tabs marked "opened by <technician>", backstage tabs with **Close** / **Close all**, denied tabs shown only as "<n> protected tabs are not shared" | §4.5 TabInfo |
| Chat | A §8.1 protocol unchanged (`ia.chat` + WS `chat.message` fallback via the service worker); `chat.channel_open` is sent by the Assist as before | `ChatPanel` logic ported, not the React component (**binding: no framework in the extension**; vanilla TS + the same CSS tokens keeps the bundle small and the CSP trivial; every message rendered with `textContent`) |
| Voice | **Unmute** / mute (default muted, A D8). **Permission flow (binding):** an offscreen document has no window and cannot show a permission prompt, so on the first **Unmute** click the **side panel itself** calls `navigator.mediaDevices.getUserMedia({ audio: true })` in the click handler, stops the track immediately, and only then sends `ui.voice { muted: false }`; the offscreen document acquires its own track afterwards (the grant is per extension origin, so no prompt). On `NotAllowedError` the panel shows "Microphone blocked for IndiansAssist; allow it in chrome://settings/content/siteDetails?site=chrome-extension://<id>" (link rendered as text plus a **Copy address** button, since `chrome://` cannot be opened from a page) and keeps `voice.available = false`. `UiState.voice.available` is `navigator.permissions.query({ name: 'microphone' }).state !== 'denied'`, refreshed on `change`. `voice.state` on `ia.ctrl` as in Phase A | A §7.7 voice |
| Files | A §8.3 protocol unchanged; send: `<input type=file>` in the panel, the panel creates a `blob:` URL and passes it to the offscreen document, which `fetch()`es it (the extension CSP `connect-src` includes `blob:` for this, §9.1) and runs the sender; receive: the offscreen document assembles the `Blob`, hands a `blob:` URL to the panel, which shows the A F6 accept dialog (extension, declared MIME, sniffed type, size, sender; file name via `textContent`) and saves with `<a download>`; attestation `desk.event file.*` as before | `fileChunker`, `fileTransfer` logic (copied into `apps/extension/src/shared/`, identical algorithms; the web `lib/` is not imported); shared `encodeFileChunk`, `sanitiseFileName`, `EXECUTABLE_EXTENSIONS` |
| Session info | session id, started at, region, "What is shared" summary, relay notice while relayed, link to the consent receipt after end (A D6; the receipt renders in the panel and offers **Download receipt (JSON)**). The P2 `Receipt` (extension-local) extends the A D6 object with `tabsShared: { host, from, to }[]`, `levelChanges: { from, to, at, requestedBy }[]`, `unmasks: { host, scope, fieldKind?, reason, durationMs }[]`, `backstage: { host, outcome }[]`, `tabActions: number`, `inputs: number`, `relayed: boolean`, all from local state (`ia.session` counters) | A D6 |
| Prompts | level requests, attach requests and unmask requests (§3.2, §5.3, §8.4) render here as cards with **Allow** / **Refuse** (level, attach) or **Show for 60 s** / **Refuse** (mask) and the technician's reason (`textContent`); the recording warning of §8.4 when applicable | |

**Offscreen document decision (binding):** the MV3 service worker cannot keep an `RTCPeerConnection` (it is terminated after 30 s of inactivity and has no `getUserMedia`). One offscreen document (`offscreen.html`, `chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WEB_RTC', 'USER_MEDIA'], justification: 'WebRTC peer connection and microphone for the support session' })`) owns the `RTCPeerConnection`, the six data channels, the microphone track, deflate/inflate, frame fragmentation and reassembly, the relay pacer, the file transfer engine and the cross-origin stylesheet fetch. The service worker owns the WS, the session state machine, `chrome.tabs/*` ops, the debugger, the attestation outbox and favicon inlining. Content scripts and UI pages talk to both over the bus of §9.3. The offscreen document is created at `consent.ok` and closed at hard rule 2 teardown.

---

## 8. Field privacy

### 8.1 Defaults

| Item | Default |
|---|---|
| Input values | masked (`maskAllInputs: true`), including search boxes and plain text inputs; the Assist sees `*` of the same length for ordinary inputs |
| Secrets: `input[type=password]`, any input that was **ever** `type=password` in this document, `autocomplete` in `current-password`, `new-password`, `cc-number`, `cc-csc`, `one-time-code` | masked to the fixed 8-char mask and **not unmaskable** (`mask.request` answers `{ granted: false }` without prompting, `mask.refused { cause: 'not_unmaskable' }` is written; the console greys the field) |
| `[data-ia-sensitive]` | subtree text masked (fixed-length); unmaskable per §8.4 |
| `[contenteditable]` | subtree text masked (fixed-length) by default; unmaskable per field (§8.4) |
| `[data-ia-block]` | not captured at all (placeholder box with the element's size); never unblockable |
| `policy.maskSelectors`, `policy.blockSelectors` | org-wide extra selectors, validated one by one (§4.1); an invalid selector is skipped and reported in the options page diagnostics |
| Cross-origin iframes, `<canvas>`, `<video>`, `<audio>`, WebGL | placeholders; input into frames answers `not_supported` (§5.4) |
| Deny-listed hosts | tab not mirrored (`denied`), no title / url / favicon disclosed, no capture script injected (§9.2), navigation to such a host by the Assist refused (`denied_url`) |

Shared marker attributes are documented for customers in `docs/extension/privacy-markers.md` (web engineer): `data-ia-sensitive`, `data-ia-block`, plus the generic `rr-mask` / `rr-block` classes rrweb honours.

### 8.2 Deny list

`ExtensionPolicy.denyList` (org, max 500 entries) and the managed `extraDenyList` (§9.4) are merged with `BUILTIN_DENY_LIST` (shared `extension/deny-list.ts`) into the effective list. Entry syntax: a hostname (`example.com`, exact match, case-insensitive, IDNA-ASCII, port ignored) or a wildcard host (`*.example.com`, matches every subdomain **and** the apex). `matchesDenyList(url: string, list: string[]): boolean` matches hosts only; `isMirrorableUrl(url)` is the separate scheme check (§4.1); `denyListToMatchPatterns(list): string[]` turns the effective list into Chrome match patterns for `excludeMatches` (`example.com` -> `*://example.com/*`; `*.example.com` -> `*://*.example.com/*` plus `*://example.com/*`). Our own API and web hosts are not denied (the Desk may need help on our site). `BUILTIN_DENY_LIST` ships with exactly these entries, one comment per line in the source, additions by pull request only:

| Group | Entries |
|---|---|
| Identity providers | `accounts.google.com`, `login.microsoftonline.com`, `login.live.com`, `appleid.apple.com`, `id.atlassian.com` |
| Indian net banking and UPI | `*.onlinesbi.sbi`, `netbanking.hdfcbank.com`, `*.icicibank.com`, `*.axisbank.co.in`, `*.kotak.com`, `*.pnbibanking.in`, `*.bankofbaroda.in`, `*.paytm.com`, `*.phonepe.com`, `*.npci.org.in` |
| Password managers | `vault.bitwarden.com`, `*.1password.com`, `*.lastpass.com`, `passwords.google.com`, `*.dashlane.com` |

Orgs may **not** remove built-in entries in Phase B (`policy.allowBuiltinOverride` is reserved). The consent window lists the effective hosts of the live session; the options page lists the built-in list plus "the organisation's list is shown during a session".

### 8.3 Pause mirroring on this tab

Tab bar **Pause this tab** and side panel toggles (§3.4). A paused tab keeps its bar (text "Paused: not shared"), the Assist sees a placeholder "Paused by the user", and `tabs.navigate`, `tabs.reload` and every `input.*` answer `tab_paused`. The extension itself pauses a tab whose bar it cannot keep visible (§3.3).

### 8.4 Unmask on request (time-bounded reveal)

| Step | Behaviour |
|---|---|
| 1 | Assist clicks a masked field (or **Reveal this tab** in the masking indicator) and types a reason (required, 1..500); console posts `mask.requested` (§3.7) and sends `mask.request { tabId, scope, nodeId?, reason }` |
| 2 | **Target rule for `field` scope:** the content script resolves `nodeId`; the target must be a form control (`input` that is not a secret, `textarea`, `select`), a `[contenteditable]` element, or a **leaf** `[data-ia-sensitive]` element (no `[data-ia-sensitive]` descendants) whose `textContent.length <= 200`; anything else (a container, `body`, a secret, an unknown node) answers `{ granted: false }` at once with `mask.refused { cause: 'bad_target' }` (`not_unmaskable` for secrets). The extension also refuses silently for any scope when `!policy.allowUnmask` (`cause: 'policy'`) |
| 3 | Otherwise the content script **outlines the target** on the Desk's page while the prompt is open (a `data-ia-block` overlay `div` with a 2 px accent outline matching the element's rect, repositioned on scroll/resize; for `tab` scope the whole viewport gets a 4 px inset outline) and calls `scrollIntoView({ block: 'center' })`, and the prompt (side panel card and tab bar, all `textContent`) reads "<technician> asks to see: <name> on <host> for up to 60 seconds. Reason: <reason>" where `<name>` = the control's `<label for>` text, else `aria-label`, else `placeholder`, else `name`, else "a field" (`tab` scope: "all hidden fields on this tab"). When `session.recording` / `recording.state` is true the card adds "This session is being recorded; the revealed value will be in the recording" (with `policy.recordRevealed`) or "... the recording will skip the revealed value" (without). Buttons **Show for 60 s** / **Refuse**; 60 s => `timeout` |
| 4 | On **Show for 60 s**: `unmaskStore.add(el, ttl)` (field) or `unmaskStore.addTab(ttl)` (tab: all `[data-ia-sensitive]`, `[contenteditable]` text and non-secret input values of that document), `ttl = LIMITS.revealTtlMs` (60 000), `record.takeFullSnapshot(true)` so the values appear, `mirror.tab { state: 'revealed' }`, bar shows the `REVEALED` chip with **Hide again**, reply `{ granted: true, ttlMs }`, `desk.event { action: 'mask.override', data: { tabId, scope, nodeId?, fieldKind, outline: { w, h }, opId, ttlMs }, reason }` |
| 5 | **The reveal ends** on the first of: `field` scope: the element loses focus (`blur`, `by: 'blur'`) or the TTL (`ttl`); `tab` scope: the TTL or the Desk's **Hide again** (`desk`); either scope: navigation, pause, level drop below the level at grant time, session end. Ending it removes the store entry, takes a full snapshot (so the mask is restored on the Assist), sends `mirror.tab { state: 'restored' }` and writes `desk.event mask.restored { tabId, scope, durationMs, by }`. A reveal is never persisted and never extended; the Assist asks again |
| 6 | **Refuse** / timeout answer `{ granted: false }` and write `mask.refused { tabId, scope, nodeId?, fieldKind?, opId, cause: 'refused' \| 'timeout' }` with the technician's reason |

The console's masking indicator (§10.4) counts masked nodes in the current snapshot and shows "N fields hidden; 1 revealed (42 s left)". The reason travels into the chain (`reason` column) on both the request and the outcome so an auditor sees why and what happened.

---

## 9. Extension architecture (`apps/extension`)

### 9.1 Manifest (`src/manifest.ts` -> `dist/manifest.json`, generated at build)

```json
{
  "manifest_version": 3, "name": "IndiansAssist", "version": "<package.json>", "minimum_chrome_version": "120",
  "description": "Share your browser tabs with your IT technician. Visible, consented, masked by default.",
  "icons": { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" },
  "action": { "default_title": "IndiansAssist", "default_icon": { "16": "icons/16.png", "32": "icons/32.png" } },
  "background": { "service_worker": "background.js", "type": "module" },
  "side_panel": { "default_path": "sidepanel.html" },
  "options_page": "options.html",
  "permissions": ["tabs", "tabGroups", "sidePanel", "storage", "scripting", "activeTab", "offscreen", "clipboardRead", "alarms"],
  "optional_permissions": ["debugger"],
  "host_permissions": ["<all_urls>"],
  "content_scripts": [
    { "matches": ["<REGION_ORIGINS[i]>/*", "..."], "js": ["bridge.js"], "run_at": "document_idle" }
  ],
  "externally_connectable": { "matches": ["<REGION_ORIGINS[i]>/*", "..."] },
  "web_accessible_resources": [],
  "content_security_policy": { "extension_pages": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src https: wss: blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'" },
  "incognito": "not_allowed",
  "storage": { "managed_schema": "managed_schema.json" }
}
```

Build-time substitution (`scripts/manifest.mjs`): `REGION_ORIGINS` = the origin values of `VITE_REGION_ORIGINS` (`in-mum=https://in.indiansassist.example,...`, the same variable the web app uses; **exact origins, `/*` suffix, no wildcard hosts**; the build **fails** when the list is empty or any entry has a `*`, a path, a non-`https:` scheme outside a dev build, or does not parse as a URL); the same list is compiled into `src/shared/constants.ts` as `REGION_ORIGINS` for the §2.2 checks; the dev build (`IA_DEV=1`) adds `http://localhost:5173` and `http://127.0.0.1:5173` to both lists and `http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*` to `connect-src`; `key` (`EXTENSION_KEY`, when set, pins the unpacked id so it can be listed in the api's `EXTENSION_IDS`); `IA_E2E=1` marks the e2e build (§13.2). `pnpm validate:infra` checks that `REGION_ORIGINS` (api), `VITE_REGION_ORIGINS` (web and extension) and `dist/manifest.json` (`externally_connectable.matches`, bridge `matches`) agree. `connect-src` includes `blob:` because the offscreen document `fetch()`es `blob:` URLs for outgoing files (§7); `data:` stays out. `content.js` (the capture script) is **not** in the manifest: it is injected dynamically while a session is active (§9.2, P7). `activeTab` is kept as the task requires although `<all_urls>` subsumes it. `content.js` and `bridge.js` are IIFEs (no ESM in content scripts); `background.js` is an ES module.

### 9.2 Contexts and files

| Context | Entry | Owns |
|---|---|---|
| Service worker | `src/background/index.ts` (`session-machine.ts`, `signal-client.ts`, `tabs-control.ts`, `debugger-control.ts`, `policy.ts`, `badge.ts`, `keepalive.ts`, `external.ts`, `content-registry.ts`, `attest-outbox.ts`, `favicons.ts`) | session state machine (`ExtensionPhase`, below), WS `/signal` client (reconnect with backoff 1, 2, 4, 8 s, max 30 s; `desk.hello` with `resumeKey` on reconnect), `desk.poll`, `chrome.tabs/*` ops and `assertNavigableUrl`, debugger and `CDP_ALLOWED_METHODS`, badge, policy cache, keepalive (`chrome.alarms.create('ia.keepalive', { periodInMinutes: 0.5 })` while a session exists; the 25 s server ping keeps the worker alive between alarms), `onMessageExternal`, capture script injection, attestation outbox, favicon inlining, local token verification |
| Offscreen document | `src/offscreen/index.ts` (`peer.ts`, `channels.ts`, `mirror-sender.ts`, `relay-pacer.ts`, `files.ts`, `voice.ts`, `css-fetch.ts`) | `RTCPeerConnection` (perfect negotiation, Desk impolite, A §7.7; rebuilt per §3.5), six channels, deflate framing and fragmentation, backpressure, relay pacing, file engine, mic, stylesheet fetch |
| Content script (capture) | `src/content/index.ts` (`recorder.ts`, `batcher.ts`, `indicator.ts`, `input-replay.ts`, `unmask.ts`, `annot-overlay.ts`, `selectors.ts`) | `record()`, batching, tab bar and its self-defence, title prefix observer, DOM input replay, coordinate resolution and the frame rule, unmask store and reveal outline, annotation overlay (A §8.2 shapes with `tabId`, drawn in a `data-ia-block` canvas), selector validation |
| Bridge content script | `src/content/bridge.ts` | `ia.ext.present` beacon and the §2.2 carrier B, only on `REGION_ORIGINS` |
| Side panel | `src/sidepanel/` (`index.html`, `index.ts`, `connect.ts`, `chat.ts`, `files.ts`, `tabs.ts`, `prompts.ts`, `voice.ts`) | §7 and the idle token entry of §2.3 |
| Popup (window) | `src/popup/` | §9.6 |
| Consent | `src/consent/` | §3.1 |
| Options | `src/options/` | API origin (drop-down over `REGION_ORIGINS`), built-in deny list (read-only), diagnostics (version, last error, skipped selectors), "Reset extension" |
| Shared (extension-local) | `src/shared/` (`bus.ts`, `storage.ts`, `file-transfer.ts`, `join-input.ts`, `api.ts`, `constants.ts`, `dom.ts`) | bus types, storage keys, ported file algorithms, join input parsing, `browser ?? chrome` shim, `REGION_ORIGINS`, `el(tag, text, attrs)` helper (the only DOM-building helper; `textContent` under the hood) |

`ExtensionPhase` (`EXTENSION_PHASES`, extension-local `constants.ts`): `idle -> have_token -> connecting -> waiting -> held -> knocked -> consent_pending -> active -> ended` (`held` and `knocked` mirror `poll.status.state` and `knock.ok`; `ended` shows the receipt until dismissed, then `idle`). `UiState.phase` and `ia.session.phase` use this enum.

**Capture script injection (P7, binding).**

| Scope | Mechanics |
|---|---|
| `all_tabs` | on `consent.ok` the worker calls `chrome.scripting.registerContentScripts([{ id: 'ia-capture', matches: ['http://*/*', 'https://*/*'], excludeMatches: denyListToMatchPatterns(effectiveDenyList), js: ['content.js'], runAt: 'document_start', allFrames: false, persistAcrossSessions: false }])` and injects into every tab already in scope (supported, not denied) with `chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })`. Deny-listed hosts never receive the script |
| `current_tab` | **no global registration.** The worker injects with `executeScript` into each attached tab (the consented tab, Assist-created tabs, backstage tabs, tabs the Desk attaches) and re-injects on that tab's `tabs.onUpdated` with `status: 'loading'` when the new URL is supported and not denied (the first snapshot of the new document is taken at `cs.start`, slightly after `document_start`; acceptable). A navigation to a denied host gets no script and the tab becomes `denied` |
| Idempotency | the script guards with an isolated-world global `globalThis.__iaCapture` (invisible to the page; this is the one allowed global) and exits when set, so a registered and an executed injection never run two recorders |
| Failure | a tab whose `executeScript` rejects or that sends no `cs.ready` within 3 s is listed as `mirrored: 'unsupported'` with `TabInfo.error: 'inject_failed'` (Chrome Web Store, discarded tabs, pages that block injection) |
| Inert until started | an injected script does nothing (no DOM touch, no Port) until it receives `cs.start`; it announces itself with `cs.ready { skippedSelectors? }` **carrying no URL** (the worker already has `tab.url`). Tabs that leave scope receive `cs.stop` |
| Lost owner | when the content script's `ia.mirror` Port disconnects and no `cs.start` / reconnect arrives within 5 s, it stops `record()`, removes the bar, restores the title and clears its state on its own (jsdom test `test/content-lifecycle.test.ts`) |
| Teardown | `unregisterContentScripts({ ids: ['ia-capture'] })` (when registered) and `cs.stop` to every injected tab |

Every file under 400 lines; `@indiansassist/shared` is imported from `dist/` for schemas, enums, `normaliseTokenInput`, `checkToken`, `encodeMirrorFrames`, `sanitiseRrwebEvent`, `stripUrlForMirror`, `matchesDenyList`, `denyListToMatchPatterns`, `isMirrorableUrl`, `effectiveMaxLevel`, `sanitiseFileName`, `encodeFileChunk`.

### 9.3 Message bus (`src/shared/bus.ts`)

Chrome messaging is JSON-only; binary never crosses the bus (events travel as JSON, bytes are framed in the offscreen document; files travel as `blob:` URLs). **Addressing (binding):** `chrome.runtime.onMessage` fires in every extension context, so every bus message carries `to: 'worker' | 'offscreen' | 'ui' | 'content'`; a listener returns `false` synchronously for a message not addressed to it (so `sendResponse` never races); request/response pairs exist only worker <-> offscreen and ui -> worker; everything else is a push over a Port. `test/bus.test.ts` asserts a `pc.close` addressed to `offscreen` is ignored by the ui listener and answered once.

| Link | Carrier | Messages (`t`) |
|---|---|---|
| content -> offscreen | `chrome.runtime.connect({ name: 'ia.mirror' })` Port, opened by the content script only after `cs.start` (the offscreen document exists by then; the worker ignores this port name; the offscreen document reads `port.sender.tab.id`) | `cs.events { events: eventWithTime[], snapshot: boolean }`, `cs.meta { title, url, favicon: null }` (title without prefix, url stripped), `cs.fetchCss { url }` |
| offscreen -> content | same Port | `oc.focus { focused: boolean }`, `oc.snapshot`, `oc.css { url, text \| null }` |
| worker <-> content | `chrome.tabs.sendMessage(tabId, msg)` -> response; content -> worker `chrome.runtime.sendMessage` | worker -> content: `cs.start { policy, technician, org, level, backstage, relayed }`, `cs.stop`, `cs.pause`, `cs.resume`, `cs.level { level }`, `cs.transport { relayed }`, `cs.input { op, args }` -> `{ ok, cx?, cy? } \| { ok: false, error }`, `cs.unmask { scope, nodeId, reason, technician, ttlMs }` -> `{ ok, fieldKind, label, outline } \| { ok: false, cause }` (shows the outline and prompt), `cs.unmaskDecision { granted }`, `cs.hide`, `cs.bar { recording?, debugger?, backstageCount?, toast? }`, `cs.annot { msg }`; content -> worker: `cs.ready { skippedSelectors? }`, `cs.navigated { url }`, `cs.pauseClicked`, `cs.stopClicked`, `cs.hideClicked`, `cs.promptAnswer { id, decision }`, `cs.revealEnded { scope, by, durationMs }`, `cs.barHidden`, `cs.error { message }` |
| worker <-> offscreen | `chrome.runtime.sendMessage` request/response plus Port `ia.offscreen` for pushes | worker -> offscreen: `pc.create { iceServers, polite: false, restart: boolean }`, `pc.signal { msg: webrtc.* }`, `pc.ice { iceServers }`, `pc.close`, `dc.send { label, msg }` (chat, ctrl, annot replies, `ctl.res`, `ctl.event`), `file.send { blobUrl, name, size, mime }`, `voice.mute { muted }`, `mirror.focus { tabId }`, `relay.policy { allowed }`; offscreen -> worker: `pc.signal { msg }`, `pc.state { connectionState, path }`, `dc.open { label }`, `dc.close { label }`, `dc.msg { label, msg }` (chat, ctrl, annot, `ctl.req`, acks), `file.offer`, `file.received { blobUrl, name, size, mime, sha256 }`, `mirror.stats { bytes, batches, kbps, transport }`, `relay.frame { msg }` (a `mirror.relay` / `control.relay` for the worker's WS), `rebuild.needed` (after the third failed recovery) |
| UI pages <-> worker | `chrome.runtime.sendMessage` for commands, Port `ia.ui` for state pushes (full `UiState` object on connect and on every change) | `ui.connect { code, via: 'clipboard' \| 'manual', deskLabel? }`, `ui.consent { decision: 'share' \| 'decline', level, scope, backstage, tabId }`, `ui.level { level }`, `ui.backstage { allowed }`, `ui.prompt { id, decision }`, `ui.stop { closeBackstage }`, `ui.revoke`, `ui.pauseTab { tabId, paused }`, `ui.hideTab { tabId }`, `ui.attachTab { tabId }`, `ui.closeBackstage { tabId \| 'all' }`, `ui.chat { text }`, `ui.sendFile { blobUrl, name, size, mime }`, `ui.fileDecision { fileId, accept }`, `ui.voice { muted }` (sent only after the panel's own `getUserMedia` succeeded, §7), `ui.dismissEnded`; pushes: `state { ...UiState }`, `chat { msg }`, `fileOffer`, `fileDone`, `prompt { id, promptKind, technician, reason, label?, host?, recording }`, `error { code, message }` |

`UiState = { phase: ExtensionPhase, token: { tier, technician, org } | null, session: { sessionId, assist, level, scope, backstage, startedAt, transport, recording, tabs: TabInfo[], backstageCount: number, debuggerTabs: number[], reveals: Record<tabId, { scope, until }> } | null, chat: ChatLine[], files: FileRow[], voice: { muted, available }, receipt: Receipt | null, lastError }`.

### 9.4 Storage keys (`src/shared/storage.ts`)

| Area | Key | Value |
|---|---|---|
| `chrome.storage.session` (cleared on browser exit, not readable by content scripts: `setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`) | `ia.session` | `{ phase, code, signalUrl, apiOrigin, tokenId, tier, sessionId, resumeKey, consent: { level, scope, backstage }, technician, org, orgId, startedAt, tabs: Record<tabId, { mirrored, paused, backstage, createdByAssist, enteredAt, reveal? }>, counters: { batches, bytes, tabActions, inputs, relayed } }` |
| `chrome.storage.session` | `ia.pending` | `{ code, apiOrigin, via: 'join' \| 'clipboard' \| 'manual', candidateTabId?, receivedAt }` before `desk.hello` |
| `chrome.storage.session` | `ia.outbox` | the §3.7 FIFO (`desk.event` frames not yet acknowledged) |
| `chrome.storage.session` | `ia.policyCache` | `{ orgId, fetchedAt, policy: ExtensionPolicy }`: the policy of the **live** session only, written at `session.created`, **cleared at `session.ended`** and on browser exit; the consent window reads policy only from the live `session.created`; the options page never shows an org's policy outside a session |
| `chrome.storage.local` | `ia.apiOrigin` | one of `REGION_ORIGINS` |
| `chrome.storage.local` | `ia.lastDeskLabel` | string (<= 80) |
| `chrome.storage.local` | `ia.pubkeys` | `Record<apiOrigin, { fetchedAt, keys: PublicKeyEntry[] }>` (§2.2 local verification, 24 h) |
| `chrome.storage.local` | `ia.diagnostics` | `{ lastError, lastSessionId, version, skippedSelectors, originRefusals }` |
| `chrome.storage.managed` (`managed_schema.json`) | `apiOrigin`, `deskLabel`, `extraDenyList: string[]`, `maxConsentLevel: ConsentLevel`, `allowDeepControl: boolean`, `allowAllTabs: boolean`, `allowBackstage: boolean`, `allowUnmask: boolean` | enterprise policy of the **Desk's** employer (often not the Assist org); read-only; the extension applies the **stricter** of managed and org policy (`effectiveMaxLevel`, scope, backstage, unmask, deny list union) and the consent window says "limited by your organisation's policy" |

Tokens, resume keys, chat text and org policies are never written to `chrome.storage.local`.

### 9.5 Build

**Decision: plain Vite multi-entry, two passes, no `@crxjs/vite-plugin`** (its Vite 8 support is not assured; the plain setup has nothing to break). `vite.config.ts` builds the HTML entries (`sidepanel`, `popup`, `consent`, `options`, `offscreen`) and `background` as ES modules with `build.rollupOptions.input` and `output.entryFileNames: '[name].js'`; `vite.content.config.ts` builds `content.ts` and `bridge.ts` as `format: 'iife'` (one file each, `inlineDynamicImports`); `scripts/manifest.mjs` writes `dist/manifest.json` from `src/manifest.ts` with the §9.1 substitutions and validations and copies `icons/` and `managed_schema.json`. Scripts: `build` (both passes + manifest), `dev` (`vite build --watch` for both + manifest; Chrome reloads via the extensions page), `typecheck`, `test` (vitest, `environment: 'node'` with a `chrome` mock from `test/chrome-mock.ts`; jsdom for the content script tests), `test:e2e` (Playwright, §13.2), `lint` (ESLint with `no-eval`, `no-implied-eval`, `no-new-func`, `no-unsanitized/method`, `no-unsanitized/property`, `no-restricted-properties` for `chrome.debugger.sendCommand`, all errors). Output `apps/extension/dist/` is what "load unpacked" points at. `pnpm build` at the root includes the extension (it is under `apps/*`). Tailwind is compiled into `dist/*.css` (no CDN, no inline styles, so `style-src 'self'` holds).

### 9.6 Popup window

`popup.html` is a standalone page opened by the worker as a 420 x 640 popup window when the join handshake (§2.2) arrives and no side panel is open for the Desk's window (the handshake has no user gesture the worker could use to open the panel). "No side panel open" is tested with `chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'], windowIds: [windowId] })` (Chrome 116+), with the worker's list of live `ia.ui` ports as the fallback when `getContexts` is unavailable. It shows: org and technician from the lookup, status line (`connecting` / `waiting` / `held` / `knocked` text from §2.4), optional "Your name", **Cancel**. It closes itself when the consent window opens. Manual and clipboard entry live in the side panel idle view (§2.3), which the popup links to ("Open the side panel instead").

### 9.7 Edge and Firefox notes

| Browser | Note |
|---|---|
| Edge | identical build; `PublicToken.extension.edgeAddonsUrl`; `browser.name = 'edge'` detected from `userAgentData.brands` |
| Firefox (not in Phase B) | `sidebar_action` instead of `side_panel`; no `offscreen` (a background page may hold the `RTCPeerConnection`); no `chrome.debugger` (`deep_control` unavailable, `maxConsentLevel` effectively `in_page`); no `externally_connectable` (bridge carrier only); `tabGroups` partial; `runtime.getContexts` absent. The code keeps `browser.*` behind the `src/shared/api.ts` shim (`globalThis.browser ?? chrome`) so the port is mechanical. |

---
## 10. Assist console additions (`apps/web`)

Route `/app/sessions/:id` detects `session.tier === 'p2_extension'` (from `session.created.tier`) and mounts `MirrorConsole` instead of the video `RemoteView`. Everything else in the console (chat, voice, files, network panel, annotation toolbar, audit tab, End session, resume) is unchanged except the P2 resume rule of §3.5 (`controller.ts` branches on the tier for `desk.reconnected` and `webrtc.offer { restart }`).

### 10.1 Components

| Component | File | Behaviour |
|---|---|---|
| `MirrorConsole` | `src/assist/console/mirror/MirrorConsole.tsx` | layout: tab strip (top), replayer host (centre), control rail (right), status bar (bottom) |
| `TabStrip` | `mirror/TabStrip.tsx` | one chip per `TabInfo` with favicon (`data:` only, else letter avatar), title, state badge (`paused`, `protected`, `too large`, `background`, `not shared`, `revealed`, `opened by you`); the focused tab highlighted; the Desk's active tab marked with a dot; click => `mirror.focus` (and `tabs.activate` only when the **Follow my focus** toggle is on and level >= `tab_control`); a chip "User switched to <title>" with **Follow** when `activeTabId` changes without a focus change (§4.3); `hiddenCount` shown as "+N not shared" |
| `ReplayerHost` | `mirror/ReplayerHost.tsx` | the sandboxed iframe of §10.2, the watermark overlay (A §9 text, CSS, `pointer-events: none`), the input capture overlay, the "Paused by the user" / "Protected page" / "Waiting for snapshot" / "Too large to mirror" / "Reconnecting" placeholders, the "embedded frame cannot be controlled" hint |
| `TabControlPanel` | `mirror/TabControlPanel.tsx` | new tab (URL), close, reload, navigate (URL field, `http(s)` only client-side too), pin, mute, move to window, group create/update/colour/collapse/ungroup; each button disabled below `tab_control` with a tooltip naming the level |
| `InputModeToggle` | `mirror/InputModeToggle.tsx` | segmented control **View** / **Tab control** / **In-page** / **Deep control**; a segment above `consent.changed.level` is greyed with "Ask the user" which opens the `ReasonDialog` and sends `level.request { level, reason }`; selecting **Deep control** sends `input.mode { mode: 'debugger' }` for the focused tab; the current effective mode is read back from `ctl.event` |
| `BackstagePanel` | `mirror/BackstagePanel.tsx` | **Open background tab** (URL) => `backstage.enter` (disabled with "The user has not allowed background tabs" when `consent.changed.backstage` is false); list of backstage tabs with **Close**, **Keep**, **Bring to front** (confirm dialog) |
| `MaskIndicator` | `mirror/MaskIndicator.tsx` | "N fields hidden; M revealed (<s> left)" from `rp.maskStats` and the reveal TTL, **Reveal this tab** (reason dialog => `mask.request`), click-to-reveal on a masked node (reason dialog); the recording warning text when recording is on |
| `MirrorStatus` | `mirror/MirrorStatus.tsx` | transport (`direct` / `relayed, not end-to-end encrypted`), mirror kbps (10 s average), last ack age, relay budget use, snapshot age |
| `mirrorRecorder` | `mirror/mirrorRecorder.ts` | §4.7 JSONL buffer with the reveal redaction rule, gzip, upload via the existing `lib/upload.ts` |
| `controlClient` | `mirror/controlClient.ts` | `ctl.req` sender with ids, `opId`, timeouts, two-bucket coalescing, relay fallback, de-duplication, the §3.7 console reporting (`POST /sessions/:id/events`) |
| `replayerBridge` | `mirror/replayerBridge.ts` | parent side of the §10.2 postMessage protocol, sanitisation before posting, source checks, `MirrorReassembler` and frame decode |
| `MirrorReplay` | `mirror/MirrorReplay.tsx` | post-session replay of a `.jsonl.gz` recording (§10.5) with the same watermark overlay |
| `AuditPairs` | `mirror/AuditPairs.tsx` | the §3.7 pairing view inside the audit tab |

### 10.2 Replayer (live mode) and sandbox

The rrweb `Replayer` runs **inside a sandboxed iframe**: `<iframe sandbox="allow-scripts" src="/replayer.html" referrerpolicy="no-referrer">`. Without `allow-same-origin` the frame has an opaque origin: no cookie, no `localStorage`, no access to the console's DOM.

**Packaging (binding; the opaque origin changes how the page may load).** An opaque-origin document fetches every `<script type=module>`, `crossorigin` script and `crossorigin` stylesheet as a CORS request with `Origin: null`; the SPA's `/assets/` are served without `Access-Control-Allow-Origin`, so the standard Vite output (`apps/web/dist/index.html` style) would leave the replayer blank behind nginx while working against the Vite dev server (`cors: true`). Therefore `replayer.html` is **one self-contained file with no network dependencies**: a dedicated `vite.replayer.config.ts` builds `src/replayer/main.ts` (rrweb replay code and the §12.3 sanitiser, nothing else) as `format: 'iife'`, `inlineDynamicImports: true`, `modulePreload: false`, `cssCodeSplit: false`, and a small plugin inlines the resulting script and CSS into `dist/replayer.html` as `<script>` and `<style>` elements (no `src`, no `href`, no `crossorigin`); the meta CSP is generated at the same step with the script's hash: `default-src 'none'; script-src 'sha256-<hash>'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'`. No `'self'` appears anywhere in the replayer's CSP, so the document is origin-independent and portable across engines. Remote images, fonts and CSS `url()` therefore **never load** in Phase B (placeholders); `policy.allowRemoteAssets` is reserved and off. The file is served by nginx from the SPA root; `pnpm build` of the web app runs both configs.

**Day-zero spike (integration engineer, before the web engineer starts `ReplayerHost`):** load `/replayer.html` in the sandboxed frame through `vite preview` with `preview.cors = false` (and through the nginx image when Docker is available), post one rrweb snapshot and assert `rp.applied`; record in this section whether rrweb's inner `about:blank` iframe is scriptable from an opaque-origin parent in Chromium (expected yes) and the Firefox note. The result is written here as "Spike S0: <date>, Chromium <version>: pass/fail" before §10 work begins.

nginx (`infra/nginx/web.conf`, new `location = /replayer.html`): the A P3 headers **minus** `X-Frame-Options` and with the header `Content-Security-Policy: frame-ancestors https://$host` (templated from the request host, equal to `WEB_ORIGIN` in production; `'self'` is not used because the embedded document's origin is opaque and `'self'` resolution is engine-dependent) instead of the SPA CSP (a meta CSP cannot carry `frame-ancestors`, and the P3 `X-Frame-Options: DENY` / `frame-ancestors 'none'` would stop the console from embedding the page), plus `Cross-Origin-Resource-Policy: same-origin` (a navigation, so CORP does not apply to the embedding itself) and `Cache-Control: no-store`. The SPA CSP gains `frame-src 'self'` (§12.2). `/assets/` keeps no CORP header (the replayer loads nothing from it, but future assets must not be blocked for the opaque frame either).

| Rule | Value |
|---|---|
| Parent -> frame | `postMessage({ t: 'rp.snapshot' \| 'rp.events' \| 'rp.reset' \| 'rp.annot' \| 'rp.setSize' \| 'rp.arm' \| 'rp.reveal', tabId, ... }, '*')` (the target origin must be `'*'` for an opaque frame; the frame checks `event.source === window.parent`); every event is passed through `sanitiseRrwebEvent` **before** posting (§12.3), and the frame runs it **again** |
| Frame -> parent | `postMessage({ t: 'rp.ready' \| 'rp.pointer' \| 'rp.key' \| 'rp.wheel' \| 'rp.maskStats' \| 'rp.applied' \| 'rp.error', ... }, '*')`; the parent checks `event.source === iframe.contentWindow` and validates each message with `replayerMessageSchema` (web-local, `mirror/replayerProtocol.ts`) |
| Replayer | `new Replayer([meta, snapshot], { root, liveMode: true, skipInactive: false, mouseTail: false, UNSAFE_replayCanvas: false, useVirtualDom: true, triggerFocus: false, pauseAnimation: false, showWarning: false, insertStyleRules: ['[data-ia-block]{outline:1px dashed #94a3b8}'] })`; `replayer.startLive(firstEvent.timestamp - 250)`; subsequent events via `replayer.addEvent(e)`; rrweb's own inner iframe keeps its default `sandbox="allow-same-origin"` (no `allow-scripts`: nothing from the mirrored page can run; scripts are stripped anyway) |
| Per tab | one `Replayer` per tab, kept for the 4 most recently focused tabs (others destroyed and rebuilt from the next snapshot); a `snapshot` frame destroys and recreates the tab's replayer; the parent sends `mirror.ack` after `rp.applied` |
| Pointer capture | the frame's transparent overlay maps `clientX/Y` to the inner iframe document: `el = innerDoc.elementFromPoint(x, y)`, `id = replayer.getMirror().getId(el)`, `nodeId = id === -1 ? null : id`, `nx/ny` from `el.getBoundingClientRect()` (omitted when `nodeId` is null), `vx/vy` from the latest `Meta` width/height of that tab; posted as `rp.pointer { kind, nodeId, nx?, ny?, vx, vy, button, modifiers, deltaX, deltaY }`; keyboard: overlay `tabindex=0`, `keydown`/`keyup` => `rp.key`; the parent turns them into §5.3 ops only when the input mode permits |
| Annotations (Y8) | P2 annotation coordinates are `vx`/`vy` relative to the tab viewport as reported by the latest `Meta` event; the console converts replayer-host pixels through the Meta size; `tabId` is **required** on `ia.annot` in P2 (the extension drops messages without it) and the content script draws in the tab's viewport |
| Masked nodes | the frame counts nodes whose text content matches `/^\*+$/` (inputs' values and text under the mask selectors) and reports `rp.maskStats { masked, revealed }`; with **Reveal** armed (`rp.arm { mode: 'reveal' }`) a click on such a node posts `rp.pointer` with `nodeId`, which the parent turns into `mask.request { scope: 'field' }` after the reason dialog |
| Accessibility | the iframe has `title="Mirrored tab: <title>"`; a live region announces tab switches, pauses, reveals and level changes (A A4); every control is keyboard reachable (A A1-A9) |

### 10.3 Network panel additions

`session.stats` gains optional `mirrorKbps`, `mirrorTabs`, `mirrorTransport: 'dc' | 'relay'`, `sessionKbps` (all data channels plus voice, informational); the panel shows them; `codec`, `fps`, `width`, `height` are `null` in P2 sessions; path detection from `getStats()` is unchanged (the data channel runs over the same ICE pair).

### 10.4 Masking indicator, reveal dialog and audit tab

The reason dialog (shared web component `ReasonDialog`) requires 1..500 characters and explains "The user decides; your reason is written to the audit trail." The audit tab renders `mask.requested` / `mask.override` / `mask.refused` / `mask.restored`, `level.requested` / `consent.level_changed` / `consent.level_refused`, `consent.backstage_changed`, `tab.action`, `control.input`, `backstage.*`, `mirror.*` and `recording.deleted` entries with human labels; pairs by `opId` per §3.7 ("<technician> requested, performed by the extension"; "reported by the Desk only"; "reported by the console only"); hosts come from the joined `session_host` plaintext when the viewer's role may see it (same rule as file names), else the hash prefix.

### 10.5 Post-session replay

Ended view of a P2 session with a stored recording of mime `application/x-ia-rrweb+jsonl`: **Replay** fetches `GET /api/v1/recordings/:id/download?inline=1` (**same-origin**: with `inline=1` the api streams the object body itself through `ObjectStorage.get` instead of answering with a presigned URL, so `RECORDING_DOWNLOAD_ORIGIN` and the SPA `connect-src 'self' wss:` never collide; same role rule, same SEC-01 headers, `Content-Type: application/octet-stream`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`; Y27), streams the body through `DecompressionStream('gzip')`, parses JSONL, groups by `tabId`, and drives the same sandboxed frame in non-live mode (`liveMode: false`, play/pause/seek, tab selector, `redacted` ranges shown as a grey band "value hidden while revealed"). `MirrorReplay` renders the **same watermark overlay** as the live view (A §9 text: assist name, user id prefix, session id prefix, recording time) over the frame; the header line's `assist` object is the forensic binding. Verify (`POST /recordings/:id/verify`) is unchanged.

---

## 11. API, db and shared additions

### 11.1 Database (`packages/db`, migration `drizzle/0003_phase_b.sql`)

| Change | Detail |
|---|---|
| pgEnum `consent_level` | `view`, `tab_control`, `in_page`, `deep_control` |
| pgEnum `mirror_scope` | `current_tab`, `all_tabs` |
| `org.extension_policy` | `jsonb not null default '{}'`; the API merges it over `DEFAULT_EXTENSION_POLICY` on every read |
| `org.recording_retention_days` | `integer null` (null = keep until deleted manually; 1..3650), Y26 |
| `session.consent_level` | `consent_level null` |
| `session.consent_scope` | `mirror_scope null` |
| `session.consent_backstage` | `boolean null` |
| `session.desk_client` | `jsonb null`, the `desk.hello.client` object (sanitised strings, each <= 32) |
| `session_host` | new table `{ id uuid pk, session_id fk, org_id fk, host_hash char(64), host text (<= 253), first_seen_at timestamptz }`, unique `(session_id, host_hash)`; mutable plaintext for display, deletable for erasure; written by the api when it maps a wire `host` (§3.6); read joined by `GET /sessions/:id/audit` for viewers with the file-name rule |
| `recording.deleted_at`, `recording.deleted_by` | `timestamptz null`, `uuid null`; the object is removed from storage, the row stays (the chain references it) |
| `recording.mime` | unchanged column; allow-list extended (§4.7) |

Wire `Session` (A §6.3) gains `consentLevel`, `consentScope`, `consentBackstage`, `deskClient` (all nullable). Append-only triggers and the lock order of A §4.2 are untouched; every new audit action goes through `insertAuditEntry`.

### 11.2 Shared (`packages/shared`)

| File | Exports |
|---|---|
| `enums.ts` | `CONSENT_LEVELS`, `ConsentLevel`, `CONSENT_LEVEL_ORDER`, `levelAtLeast(a, b)`, `MIRROR_SCOPES`, `MirrorScope`, `DESK_CLIENT_KINDS` (`web`, `extension`), `INPUT_MODES` (`dom`, `debugger`), `MIRROR_TRANSPORTS` (`dc`, `relay`), `MIRROR_STOP_REASONS`, `MIRROR_START_REASONS`, `MASK_SCOPES` (`field`, `tab`), `FIELD_KINDS`, `MASK_REFUSE_CAUSES`, `MASK_RESTORE_CAUSES`, `BACKSTAGE_OUTCOMES`, `MASK_FIXED`, `DATA_CHANNEL_LABELS` (+ `ia.mirror`, `ia.control`), `LIMITS` additions below, `EXTENSION_ID_PLACEHOLDER`; `WS_CLOSE` unchanged |
| `extension/policy.ts` | `extensionPolicySchema`, `ExtensionPolicy`, `DEFAULT_EXTENSION_POLICY`, `extensionPolicyPatchSchema`, `mergePolicy(stored)`, `effectiveMaxLevel(policy, managed?)`, `managedPolicySchema` |
| `extension/deny-list.ts` | `BUILTIN_DENY_LIST`, `normaliseHostPattern`, `matchesDenyList(url, list)`, `isMirrorableUrl(url)`, `denyListToMatchPatterns(list)`, `stripUrlForMirror(url)`, `hostOf(url)` |
| `extension/mirror-frame.ts` | `encodeMirrorFrames({ kind, tabId, seq, rawLength, payload, deflate, chunkBytes })`, `decodeMirrorFrame(buf)` (`{ ok: true, header, chunk } \| { ok: false, reason }`), `MirrorReassembler`, `MIRROR_FRAME_VERSION = 2` |
| `extension/control.ts` | `CONTROL_OPS`, `ControlOp`, `controlRequestSchema`, `controlResponseSchema`, `controlEventSchema` (`z.discriminatedUnion('kind', ...)`), `controlMessageSchema`, `ControlMessage`, `CONTROL_ERROR_CODES`, `ControlErrorCode`, `minLevelFor(op)`, `TAB_ACTION_KINDS`, `TabActionKind`, `tabInfoSchema`, `TabInfo`, `groupInfoSchema`, `windowInfoSchema`, `modifiersSchema`, `opIdFor(sessionId, reqId)` |
| `extension/handshake.ts` | `EXT_HANDSHAKE_VERSION`, `joinHandshakeSchema` (strict `{ t, v, code }`), `joinReplySchema`, `extPingSchema`, `extPongSchema`, `extPresentSchema` (§2.1, §2.2) |
| `extension/rrweb-sanitise.ts` | `sanitiseRrwebEvent(event: unknown): unknown` (§12.3; structural, no rrweb import), `sanitiseSnapshotNode`, `sanitiseCssText`, `isAllowedUrl` |
| `schemas/datachannel.ts` | `dcMirrorTabsSchema`, `dcMirrorTabSchema`, `dcMirrorAckSchema`, `dcMirrorNackSchema` added to `dataChannelMessageSchema`; `controlMessageSchema` members (`ctl.req`, `ctl.res`, `ctl.event`) added too; `annot*` schemas gain **required-in-P2** `tabId?` (optional in the type, the extension enforces presence) |
| `schemas/signal-messages.ts` | `deskClientSchema`; `deskHelloSchema` + `client?`; `deskConsentSchema` + `extension?: { level, scope, backstage }`; `consentChangedSchema` + `level?`, `scope?`, `backstage?`; `sessionCreatedSchema` + `extension?: { policy }`; `sessionStatsSchema` + `mirrorKbps?`, `mirrorTabs?`, `mirrorTransport?`, `sessionKbps?`; `deskEventSchema` action union + per-action data + `reason?`; `webrtcOfferSchema` + `restart?`; new `deskConsentLevelSchema` (`desk.consent_level` + `opId?`), `deskConsentBackstageSchema` (`desk.consent_backstage`), `consentLevelOkSchema` (`consent.level_ok { sessionId, level, backstage }`), `mirrorRelaySchema` (with the `json` refinement), `controlRelaySchema`; `signalErrorSchema` details for `join_unsupported` |
| `schemas/signal.ts` | the three unions include the new messages; `DESK_CLIENT_TYPES` + `desk.consent_level`, `desk.consent_backstage`, `mirror.relay`, `control.relay`; `ASSIST_CLIENT_TYPES` + `mirror.relay`, `control.relay` |
| `schemas/rest-tokens.ts` | `publicTokenSchema` + `extension: { ids, webStoreUrl, edgeAddonsUrl, minVersion } \| null` |
| `schemas/rest-sessions.ts` | `sessionSchema` + `consentLevel`, `consentScope`, `consentBackstage`, `deskClient`; `sessionEventBodySchema` action union extended (§3.6) with `assistEventDataSchema(action)`; `RECORDING_MEDIA_TYPES` + `application/x-ia-rrweb+jsonl`, `RECORDING_MIME_RE` extended, `recordingFileExtension` -> `jsonl.gz`; `recordingSchema` + `deletedAt` |
| `schemas/rest-core.ts` | `extensionPolicyResponseSchema` (= `ExtensionPolicy` + `builtinDenyList`), `retentionPolicySchema` |
| `audit/actions.ts` | the §3.6 actions in `AUDIT_ACTIONS` with chain schemas (`auditDataSchema`); `session.consent_granted` optional `level`/`scope`/`backstage`; `deskEventDataSchema(action)` (wire, Desk); `assistEventDataSchema(action)` (wire, console); `hostToHash(data, hasher)` helper the api uses to map `host -> hostHash` |

`LIMITS` additions: `mirrorBatchMaxEvents: 64, mirrorBatchMaxMs: 200, mirrorBatchMaxRawBytes: 262144, mirrorSnapshotMaxRawBytes: 8388608, mirrorRelaySnapshotMaxBytes: 2097152, mirrorDeflateMinBytes: 1024, mirrorDcChunkBytes: 65536, mirrorDcMaxParts: 256, mirrorReassembleTimeoutMs: 2000, mirrorDcPauseBytes: 1048576, mirrorDcResumeBytes: 262144, mirrorDcStallMs: 3000, mirrorAckIntervalMs: 2000, mirrorAckTimeoutMs: 10000, mirrorNackIntervalMs: 2000, mirrorBackgroundBufferBytes: 2097152, mirrorCssSheetMaxBytes: 524288, mirrorCssTabMaxBytes: 4194304, mirrorRelayDataChars: 40960, mirrorRelayMaxParts: 256, mirrorRelayBudgetBytes: 524288, mirrorRelayBudgetWindowSec: 10, controlRelayMaxBytes: 16384, controlRelayPerSec: 10, controlOpsPerSec: 30, controlOpsBurst: 60, pointerMovesPerSec: 30, controlRequestTimeoutMs: 10000, promptTimeoutMs: 60000, promptRequestTimeoutMs: 65000, controlInputAggregateMs: 10000, revealTtlMs: 60000, revealFieldTextMax: 200, deskEventOutboxPerSec: 4, deskEventOutboxBurst: 15, assistEventsPerSec: 10, assistEventsBurst: 30, faviconMaxBytes: 8192, policyDenyListMax: 500, policyHostPatternMax: 253, policySelectorsMax: 50, policySelectorMax: 200, policyJsonMaxBytes: 32768, reasonMax: 500, fillValueMax: 4000, tabsCloseMax: 50, deskClientStringMax: 32, browserVersionMax: 8, recordingRetentionDaysMax: 3650`.

`ExtensionPolicy` (`DEFAULT_EXTENSION_POLICY`):

```json
{ "denyList": [], "maskSelectors": [], "blockSelectors": [], "defaultConsentLevel": "tab_control", "maxConsentLevel": "deep_control",
  "allowDeepControl": true, "allowAllTabs": true, "allowUnmask": true, "backstageAllowed": true, "recordMirror": false, "recordRevealed": false,
  "allowRelayFallback": true, "titlePrefix": true, "allowRemoteAssets": false, "updatedAt": null }
```

Validation: `defaultConsentLevel <= effectiveMaxLevel(policy)` (else `400 validation_failed`); `allowRemoteAssets` is accepted but ignored in Phase B (reserved); strings sanitised per A §5.3; host patterns validated by `normaliseHostPattern` (lower-case, IDNA, `*.` prefix only); selectors `<= 200` chars each, `<= 50` per list; the stored policy JSON must stay under `policyJsonMaxBytes` (32 KiB, `400 validation_failed`) so `session.created` stays under the 64 KiB WS frame.

### 11.3 REST

| Method / path | Roles | Request | Response |
|---|---|---|---|
| `GET /api/v1/orgs/current/policy/extension` | any authenticated role | | `200 ExtensionPolicy` merged with defaults, plus `builtinDenyList: string[]` (read-only) |
| `PATCH /api/v1/orgs/current/policy/extension` | org_admin | partial `ExtensionPolicy` (`extensionPolicyPatchSchema`; `null` resets a field to default) | `200` as GET; audit `org.policy_updated { fields }`; live sessions are not re-policed (the policy is sent at `session.created`); 10 / minute per user |
| `GET` / `PATCH /api/v1/orgs/current/policy/retention` | org_admin (GET: any role) | `{ recordingRetentionDays: number \| null }` | `200` same; audit `org.policy_updated { fields: ['recordingRetentionDays'] }` (Y26) |
| `DELETE /api/v1/recordings/:id` | org_admin, auditor | | `204`; removes the object (`ObjectStorage.delete`), sets `deleted_at`/`deleted_by`, audit `recording.deleted { recordingId, cause: 'manual', bytes }`; `409 already_ended`-style `recording_deleted` when already deleted; the sweeper deletes recordings older than `recording_retention_days` with `cause: 'retention'` (actor system). Verify / download of a deleted recording answer `410 link_expired`-style `recording_deleted` (Y26) |
| `GET /api/v1/recordings/:id/download?inline=1` | unchanged roles | | streams the object body (§10.5, Y27) instead of the presigned URL |
| `POST /api/v1/sessions/:id/events` | unchanged roles | action union extended (§3.6, Y24), `assistEventDataSchema(action)`, `reason?` | `201` as before; 10 / s burst 30 per session |
| `POST /api/v1/tokens/public-lookup` | none; **extension origins accepted (Y21)** with `X-Requested-With` | unchanged | `PublicToken.joinSupported = true` for `p2_extension`; new `extension: { ids: string[], webStoreUrl: string \| null, edgeAddonsUrl: string \| null, minVersion: string } \| null` (non-null only for `p2_extension`, from env `EXTENSION_IDS`, `EXTENSION_WEBSTORE_URL`, `EXTENSION_EDGE_URL`, `EXTENSION_MIN_VERSION`) |
| `POST /api/v1/tokens` | unchanged | `tier: 'p2_extension'` was already accepted in Phase A (seat cap) | unchanged |
| `GET /api/v1/sessions/:id` | unchanged | | `Session` with the §11.1 fields |
| `GET /api/v1/sessions/:id/audit` | unchanged | | entries unchanged; `hosts: Record<hostHash, host>` side map from `session_host` for roles that may see file names |
| `GET /api/v1/orgs/current/residency` | unchanged | | gains `extensionPolicy: { allowRelayFallback, recordRevealed }`, `relaySessions`, `relayBytes` (30 days), `recordingRetentionDays` |
| recordings | unchanged routes | `mime: 'application/x-ia-rrweb+jsonl'` accepted (§4.7) | download headers per §4.7 |

Env additions (`apps/api`, documented in `infra/.env.example`): `EXTENSION_IDS` (comma list, default empty; also the Y21 Origin allow-list), `EXTENSION_WEBSTORE_URL` (default empty => `null`), `EXTENSION_EDGE_URL` (same), `EXTENSION_MIN_VERSION` (default `0.2.0`), `MIRROR_RELAY_BUDGET_BYTES` (default `524288`). Web: none new (the join page reads `PublicToken.extension`). Extension build: `VITE_REGION_ORIGINS` (shared with the web app; replaces revision 2's `VITE_WEB_ORIGINS`), `VITE_DEFAULT_API_ORIGIN`, `EXTENSION_KEY`, `IA_DEV`, `IA_E2E`.

### 11.4 WS summary of changes (A §7.3)

| `t` | Dir | Change |
|---|---|---|
| upgrade | D | `Origin: chrome-extension://<id>` accepted for ids in `EXTENSION_IDS` (Y21) |
| `desk.hello` | D->S | + `client?` (§2.4); tier gate |
| `desk.consent` | D->S | + `extension?: { level, scope, backstage }` (§3.1) |
| `consent.changed` | S->A | + `level?`, `scope?`, `backstage?` |
| `session.created` | S->A, S->D | + `extension?: { policy: ExtensionPolicy }` when `tier === 'p2_extension'` (both copies; the Desk copy still carries no ICE) |
| `desk.consent_level` | D->S | new `{ sessionId, level, requested?: boolean, opId? }`; reply `consent.level_ok { sessionId, level, backstage }`; `active` only |
| `desk.consent_backstage` | D->S | new `{ sessionId, backstage }`; reply `consent.level_ok`; `active` only; audit `consent.backstage_changed` |
| `consent.level_ok` | S->D | new (§3.2) |
| `webrtc.offer` | D->S->A | + `restart?: boolean` (§3.5, Y23) |
| `mirror.relay` | D<->S<->A | new (§4.6); direction and `allowRelayFallback` rules |
| `control.relay` | A<->S<->D | new (§4.6); direction rule |
| `desk.event` | D->S | action union and `reason?` (§3.6); wire `host` -> chain `hostHash` |
| `session.stats` | A->S | + `mirrorKbps?`, `mirrorTabs?`, `mirrorTransport?`, `sessionKbps?` |
| `ice.refresh` | S->D | also sent right after an extension resume into `active` (§3.5); the Desk rebuilds its PC on it |
| `ping` / `pong` / `session.end` / `desk.consent` | both | exempt from the connection frame bucket (Y25) |
| `error` | S->* | no new codes; `join_unsupported` gains `details: { tier, expectedClient }` |

Multi-node (A §7.6): relay frames are session-scoped and ride the existing bridge; the relay counters live on the owner node like the chat counter.

---
## 12. Security

### 12.1 Threat model (P2-specific; A §11.4 and the Phase A model remain)

| Asset / surface | Threat | Mitigation |
|---|---|---|
| Extension as attack surface (`<all_urls>` host permission, `debugger`) | a malicious web page drives the extension or reads its state | the capture script exists in pages only during a session, never on deny-listed hosts, and under `current_tab` only in attached tabs (P7); it exposes nothing to the page (one isolated-world guard global, closed shadow root, no `web_accessible_resources`); the bridge accepts `postMessage` only from `event.source === window` on `REGION_ORIGINS` and forwards only `ia.join` / `ia.ext.ping`; `onMessageExternal` re-checks the full `sender.origin`; `externally_connectable.matches` = exact region origins, no wildcard; `chrome.storage.session` access level `TRUSTED_CONTEXTS` |
| Token handoff | a page on another origin, or on a sibling subdomain of ours, injects a token or names a server so the Desk joins an attacker's session | the join message carries only `{ t, v, code }`; the extension never accepts a URL from a page; `apiOrigin` must be one of the compiled `REGION_ORIGINS` (exact origin compare, independent of the sender allow-list which is generated from the same list); compact tokens are verified locally against the region's published key before any network call; the lookup, org, technician and `signalUrl` come from that server; the knock still needs a human accept, then the Desk's consent |
| Server impersonation of the extension / CSRF | a page uses the relaxed Origin rule | Y21 accepts `chrome-extension://` origins only for `POST /tokens/public-lookup`, `GET /.well-known/indiansassist.json` and the `/signal` upgrade (Desk messages only), only for ids in `EXTENSION_IDS` in production, and still requires `X-Requested-With: IndiansAssist`; every cookie-authenticated route keeps the Phase A rule |
| Mirrored DOM on the Assist | stored XSS: the mirrored page carries scripts, handlers, `javascript:` URLs, `<meta http-equiv>`, `<base>`, `srcdoc` iframes | replayer in a sandboxed iframe with an opaque origin and a hash-only `script-src`; `sanitiseRrwebEvent` strips on both ends with an **allow-list** of URL schemes and CSS rules for every CSS-bearing source (§12.3); rrweb's inner iframe runs no scripts; the console never injects mirrored HTML into its own document |
| Markup injection into the Desk's pages and extension pages | a compromised technician account or modified console puts markup into `reason`, chat, file names or page-derived labels; the content script renders them inside the Desk's page under the page's CSP | every non-bundle string is inserted with `textContent` (conventions table); `innerHTML` and friends are lint errors in `apps/extension`; `test/indicator.test.ts` and `test/prompts.test.ts` mount the bar and the prompt card with a `<img src=x onerror=...>` reason and assert no element was created and the text is literal |
| Exfil via the replayer | mirrored `<img src>`, CSS `url()`, `@font-face`, `<link>` make the technician's browser fetch attacker URLs (tracking, IP leak, credential-bearing URLs) | replayer CSP `img-src data: blob:; font-src data:; connect-src 'none'`; `referrerpolicy="no-referrer"`; `allowRemoteAssets` reserved and off; favicons are `data:` inlined by the Desk's extension or absent; `Meta.href` and `TabInfo.url` are stripped of query and fragment |
| Deep control | input injection used beyond consent; input into invisible frames; CDP used beyond input; the infobar suppressed | `debugger` is an optional permission requested on the consent / Allow gesture and removed at session end; attach only for `deep_control`; detach on every downgrade / navigation to a denied host / pause / end; frame hits answer `not_supported` in both modes; `CDP_ALLOWED_METHODS` + single `sendCommand` wrapper + lint + test; infobar never suppressed; `DBG` badge and chip; `control.input { mode: 'debugger' }` in the chain from both reporters |
| Masking bypass | unmask of passwords through a type flip; editors mirrored unmasked; a `field` request naming a whole section; a reveal that never ends; revealed values in the recording | `everPassword` WeakSet; `[contenteditable]` masked by default; `field` targets limited to controls and leaf sensitive elements with an on-page outline; reveals are 60 s / blur / **Hide again** bounded and chained on both ends; recorder redaction unless `recordRevealed`; policy comes from the server at `session.created`, never from the Assist |
| Backstage | a background tab opened on a signed-in site without the Desk noticing | Desk consent checkbox (default off for `current_tab`), deny list on the URL, active-tab toast with **Close it**, `(+n)` suffix on every bar, side panel chip, both reporters in the chain |
| Relay abuse and plaintext | mirror payloads through the server flood it or are kept or read | per-session byte budget (pacing + drop), part size, parts cap, connection bucket; direction rules; no reassembly, no persistence, no logging (`*.data`, `*.msg` in pino redact); `mirror.relayed` counts in the chain; `policy.allowRelayFallback` lets an org refuse it; declared as Y22 |
| Tab enumeration | technician learns about tabs outside consent | `current_tab` scope lists only shared tabs; denied and out-of-scope tabs have no title/url/favicon and are excluded from `tabs.query` before filtering; incognito never |
| Audit integrity | a modified extension fabricates or omits technician actions; a technician repudiates genuine ones | two reporters per op correlated by `opId` (§3.7); single-source rows are labelled; refusals are chained; the console's reports ride the authenticated REST route |
| Service worker restarts | lost consent state leads to silent re-sharing | state in `storage.session`; resume keeps `active` only with a valid `resumeKey`; indicators are re-applied to every mirrored tab on restart; a worker that cannot restore `ia.session` ends up `idle`, un-injects the capture script, and the server ends the session after the 30 s grace |
| Cross-org leakage on a shared Desk | the previous org's deny list and selectors persist on disk | policy cache lives in `storage.session`, keyed by `orgId`, cleared at `session.ended` |
| Supply chain | rrweb or a transitive package compromised | exact pin via the pnpm catalog; `pnpm audit` in CI; licence register entry; no `eval` / `new Function` anywhere (ESLint `no-eval`, `no-implied-eval`, `no-new-func` as errors in the extension and web configs); MV3 forbids remote code |
| Recording | mirror recording leaks unmasked data or outlives its purpose | the recording holds exactly what the Assist saw (masked) minus revealed values by default; stored like video with sha256 in the chain; download headers prevent rendering; deletion endpoint and retention policy (Y26) |

### 12.2 CSP and headers

Extension pages: §9.1 CSP (no `unsafe-inline`, no `unsafe-eval`, no remote scripts; `connect-src` includes `blob:` for outgoing files; Tailwind is compiled, not CDN). Web: the A P3 SPA CSP (`infra/nginx/security-headers.conf`) gains `frame-src 'self'` so the console can embed `/replayer.html`; `/replayer.html` gets the dedicated header set of §10.2 (`frame-ancestors https://$host` header, no `X-Frame-Options`, own hash-based meta CSP, no network dependencies). `connect-src` for the SPA stays `'self' wss:` (replay uses the same-origin `inline=1` download, §10.5).

### 12.3 `sanitiseRrwebEvent` (binding, shared, applied by the extension before send and by the console before replay)

| Rule |
|---|
| Remove snapshot nodes (and their subtrees) with tag `script`, `noscript`, `object`, `embed`, `applet`, `iframe` (any origin; the iframe becomes a placeholder `div` with the iframe's size), `frame`, `frameset`, `base`, `template`, `portal`, `link` with `rel` containing `import`, `preload`, `prefetch`, `modulepreload`, `meta` with `http-equiv` or `charset`; the placeholder keeps `rr_width`/`rr_height` so layout survives |
| Remove every attribute whose name starts with `on`, and the attributes `srcdoc`, `formaction`, `ping`, `integrity`, `nonce`, `sandbox`, `allow` |
| **URL attributes are allow-listed** (`href`, `src`, `action`, `xlink:href`, `poster`, `data`, `cite`, `background`, `srcset` entries, `style` `url()`): after trimming and control-character removal a value is kept only when it is relative (no scheme), `#...`, or has scheme `http:`, `https:`, `mailto:`, `tel:`, or is `data:image/(png\|jpeg\|gif\|webp\|avif\|bmp\|x-icon)` (**not** `svg+xml`, and no `data:` at all on `href`, `action`, `data`, `cite`); everything else (`javascript:`, `vbscript:`, `data:text/*`, `data:application/*`, `data:image/svg+xml`, `blob:`, `file:`, `ms-its:`, unknown schemes) becomes `about:blank#ia-blocked` (`isAllowedUrl(attr, value)`) |
| `Meta` events (type 4): `href` is replaced by `stripUrlForMirror(href)` (origin + path; query and fragment carry tokens, session ids and search terms). Page-content `href` / `action` attributes are **not** stripped: they are the page the Desk sees, they never load in the replayer, and the technician may need to read them |
| CSS text (`style` attributes, `<style>` text, `_cssText`): `expression(`, `-moz-binding`, `behavior:`, `@import` removed; every `url(...)` passed through `isAllowedUrl` (`sanitiseCssText`) |
| Incremental events: the node and attribute rules apply to `Mutation` (source 0) adds, attribute changes and `texts`; the CSS text rules apply to `StyleSheetRule` (source 8, each `adds[].rule`) and `StyleDeclaration` (source 13, `set.value`); `AdoptedStyleSheet` (source 15) events are **dropped** entirely in Phase B; `type: 5` (custom) and `type: 6` (plugin) events are dropped |
| Output is the same event shape (no re-typing needed); the function never throws on unknown shapes (it returns `null`, and the caller drops the event) |

Unit tests cover each rule with a fixture per row (including `?token=...#t=...` in a `Meta` event, `data:image/svg+xml` on `href`, `ms-its:` on `src`, an `@import` inside a source-8 rule, a source-15 event) and a round-trip of a clean event (deep-equal in, deep-equal out).

### 12.4 Rate limits and audit summary

| Scope | Limit |
|---|---|
| `mirror.relay` | connection bucket 20 / s burst 60 (`ping`, `pong`, `session.end`, `desk.consent` exempt); session budget 512 KiB per 10 s (Desk paces, server drops and counts); `data` <= 40960 chars; `parts` <= 256; Assist side `kind: 'json'` only |
| `control.relay` | 10 / s per session per direction; 16 KiB; direction rule |
| `desk.event` | unchanged 5 / s burst 20; the extension's outbox drains at 4 / s burst 15 and never drops (§3.7); `control.input` aggregated per 10 s |
| `POST /sessions/:id/events` | 10 / s burst 30 per session (P2 console reporting) |
| `PATCH policy/extension`, `policy/retention` | 10 / minute per user |
| control ops at the extension | 30 / s burst 60 general bucket; pointer moves 30 / s own bucket; `tabs.close` 50 ids; `input.fill` 4000 chars |
| prompts | one open `level.request`, one open `mask.request` and one open `mirror.attach` at a time per session (a second one answers `rate_limited`; the Assist waits) |

pino `REDACT_PATHS` (`apps/api/src/lib/logger.ts`) gains `'*.data'`, `'*.events'`, `'*.msg'`, `'*.value'`, `'*.host'` (relay payloads, control args, wire hosts). The §3.6 actions complete the audit story: every tab, input, backstage, mask and level request **and** outcome is in the chain from both sides, with the technician recoverable through the session.

---

## 13. Tests and quality gates

### 13.1 Unit tests (vitest)

| Package | Files (new) | Covers |
|---|---|---|
| shared | `test/extension-policy.test.ts`, `test/deny-list.test.ts`, `test/mirror-frame.test.ts`, `test/control-schemas.test.ts`, `test/rrweb-sanitise.test.ts`, `test/handshake.test.ts`, `test/signal-schemas.test.ts` (extended), `test/datachannel-audit.test.ts` (extended), `test/rest-schemas.test.ts` (extended) | policy merge, validation, `effectiveMaxLevel` with and without managed caps, size cap; host pattern matching (apex, wildcard, IDNA, ports ignored), `isMirrorableUrl`, `denyListToMatchPatterns`, `stripUrlForMirror`; frame encode/decode incl. deflate, fragmentation into N parts, reassembly in and out of order, timeout, the 8 MiB refusal; every op's args schema (`url` refinements, `level.request` reason rule, `nodeId`/`nx`/`ny` rule) and `minLevelFor`; `controlEventSchema` as a discriminated union with `promptKind`; each §12.3 rule incl. the allow-list and sources 8/13/15; strict handshake shape; new WS and audit schemas, `deskEventDataSchema` / `assistEventDataSchema` / `auditDataSchema` per action (wire has `host`, chain has `hostHash`, neither accepts the other), `mirrorRelaySchema` json refinement, `webrtcOfferSchema.restart`; `PublicToken.extension`, rrweb mime, `tabInfoSchema` favicon rule |
| db | `test/schema.test.ts` (extended) | migration `0003_phase_b` applies on PGlite; new enums; `session.consent_level` / `consent_backstage` round trip; `session_host` unique; audit round-trip for each new action |
| api | `test/extension-policy.test.ts`, `test/signal-p2.test.ts`, `test/relay.test.ts`, `test/recordings.test.ts` (extended), `test/events-p2.test.ts`, `test/security-origin.test.ts` | policy GET/PATCH roles, audit, rate limit; retention GET/PATCH and sweeper deletion; `desk.hello` tier gate with `client`; `desk.consent` with `extension` (required for p2, rejected for p1, `effectiveMaxLevel` cap incl. `allowDeepControl: false`, scope cap, backstage cap); `desk.consent_level` / `desk.consent_backstage` flow and `consent.changed`; `desk.event` for every new action incl. `reason`, and **`tab.action { host: 'example.com' }` yields an entry whose `data.hostHash === piiHash(org, 'example.com')` with no `host` key and a `session_host` row**; `POST /sessions/:id/events` with the new actions and the rate limit; relay authorisation, budget drop + `dropped` counter, part limits, direction rules, `allowRelayFallback: false` => `bad_state`, `mirror.relayed`; frame-bucket exemptions; extension resume keeps `active` and sends `ice.refresh`; **WS upgrade with `Origin: chrome-extension://<listed id>` succeeds, unlisted id fails `403`, `assist.hello` from an extension origin is `forbidden`; `POST /tokens/public-lookup` with an extension Origin passes CSRF only with `X-Requested-With`**; rrweb mime accepted, download headers, `inline=1` streaming, `DELETE /recordings/:id` |
| web | `test/mirrorConsole.test.tsx`, `test/controlClient.test.ts`, `test/replayerBridge.test.ts`, `test/mirrorRecorder.test.ts`, `test/joinPageP2.test.tsx`, `test/resumeP2.test.ts`, `test/auditPairs.test.tsx` | tab strip states incl. "User switched" chip, level greying, backstage disabled without consent, confirm dialogs; op ids and `opId`, timeouts, two-bucket coalescing, relay fallback, de-duplication, console event reporting; postMessage source checks, sanitisation before posting, reassembly; JSONL header, reveal redaction, gzip; join page detection with origin/source checks (a foreign-source `ia.ext.present` is ignored), handshake replies, clipboard only on failure/J4, non-Chromium message; **P2 `desk.reconnected { active }` keeps the link, a `webrtc.offer { restart: true }` rebuilds the PC and keeps the recorder**; audit pairing and single-source labels |
| extension | `test/session-machine.test.ts`, `test/attest-outbox.test.ts`, `test/batcher.test.ts`, `test/mirror-sender.test.ts`, `test/relay-pacer.test.ts`, `test/tabs-control.test.ts`, `test/debugger-control.test.ts`, `test/input-replay.test.ts` (jsdom), `test/indicator.test.ts` (jsdom), `test/prompts.test.ts` (jsdom), `test/unmask.test.ts` (jsdom), `test/selectors.test.ts` (jsdom), `test/content-lifecycle.test.ts` (jsdom), `test/external.test.ts`, `test/storage.test.ts`, `test/bus.test.ts`, `test/content-registry.test.ts`, `test/policy.test.ts` | state transitions incl. resume from `storage.session`, PC rebuild on resumed `ice.refresh`, teardown order (flush before `session.end`), `tabs.close` with 50 ids => one `desk.event`; outbox rate and no-loss; 64 / 200 ms flushes, split at 256 KiB, unfocused buffering and overflow, nack coalescing; backpressure thresholds per chunk and stall recovery; relay pacing against the budget, `too_large` on relay; every op's level/scope/deny/paused/backstage-consent checks against a `chrome` mock, `assertNavigableUrl` for `tabs.create`/`navigate`/`reload`/`backstage.enter` (`chrome://`, `file:`, `javascript:` => `bad_args`; denied host => `denied_url`), `tabs.query.urlHost` never matching hidden tabs, `createdByAssist`, focus ownership; **CDP allow-list: any method outside `CDP_ALLOWED_METHODS` throws and never reaches the mock**; coordinate resolution, frame-hit `not_supported`, dispatch sequences; bar DOM, `data-ia-block`, title prefix restore and re-apply, self-defence re-append and pause after 3 s, toast; prompt card with `<img onerror>` reason creates no element; `everPassword`, `[contenteditable]` masking, fixed mask, field-target rule, TTL/blur/Hide again ending with `mask.restored`; selector validation and fallback; Port-loss self-stop after 5 s; **handshake: allow-listed sender ok, allow-listed sender with any extra key => `version`, sibling-subdomain sender => `origin`, `apiOrigin` always from `REGION_ORIGINS`, `X-Requested-With` sent, local token verification failure => `bad_code`**; no token / policy in `storage.local`, policy cache cleared at end; bus `to` addressing; inject per scope, `excludeMatches` from the deny list, guard global, `inject_failed`; `effectiveMaxLevel` with managed caps |

### 13.2 Playwright extension e2e (`apps/extension/test/e2e/`, integration engineer)

`chromium.launchPersistentContext(tmpProfile, { channel: 'chromium', args: ['--disable-extensions-except=<dist>', '--load-extension=<dist>'] })` (Playwright's `chromium` channel is the new headless build, which supports extensions; CI needs no xvfb); the Assist runs in a second context (ordinary `browser.newContext()`) against `pnpm dev` (api :4000, web :5173) with `RATE_LIMIT_DISABLED=true`, `EXTENSION_IDS` set to the unpacked id (from `EXTENSION_KEY`), and a fixture server on **:4175** serving `test/fixtures/form.html` (inputs, `[data-ia-sensitive]`, `[data-ia-block]`, a password with a "show password" eye, a `contenteditable` editor, a cross-origin stylesheet from `http://127.0.0.1:4175/theme.css` while the page is on `localhost`, a same-origin iframe and a cross-origin iframe with a button, a long scrolling list, a button that opens a new tab), `test/fixtures/heavy.html` (large DOM over the snapshot limit) and `test/fixtures/spa.html` (a 500-row list re-rendered on filter input, §13.4). The deny-list test uses `127.0.0.1` as the denied host and `localhost` as allowed (policy patched via the API). The e2e build (`IA_E2E=1` in `scripts/manifest.mjs`) **pre-grants** `debugger` by seeding `tmpProfile/Default/Preferences` (`extensions.settings.<id>.granted_permissions.api = ['debugger']`) before launch, because `chrome.permissions.request` shows a native bubble Playwright cannot click; the microphone is granted with `context.grantPermissions(['microphone'])`. The consent-page `permissions.request` path is covered by the unit tests against the chrome mock.

| # | Scenario | Expected |
|---|---|---|
| E1 | Join page -> **Open in extension** (carrier A), Assist accepts, consent **This tab only / Tab control**, **Share** | badge `ON`, bar in the fixture tab, Assist tab strip shows one tab, snapshot applied within 3 s **with the cross-origin stylesheet applied** (computed colour asserted in the replayer frame), `session.consent_granted { level: 'tab_control', scope: 'current_tab', backstage: false }` and `mirror.started` in the session audit; the clipboard was **not** written |
| E2 | Carrier B only (`EXTENSION_IDS` empty) | same result through the bridge |
| E3 | Typing into the form on the Desk; Desk allows a **Reveal this tab** | Assist sees `*` masks in inputs, the fixed 8-char mask on the password, masked `[data-ia-sensitive]` and `contenteditable` text; `[data-ia-block]` is a placeholder; after the reveal the plain inputs and the editor are visible, **the password stays masked after the Desk clicks the "show password" eye** (type flipped to `text`); `REVEALED` chip on the bar; **Hide again** restores the masks; the chain has `mask.requested`, `mask.override { scope: 'tab' }` with the reason, and `mask.restored { by: 'desk' }` |
| E4 | Assist opens a new tab, navigates, pins, mutes, groups, closes | each op appears as a **pair** (`user` + `desk` `tab.action` with the same `opId`) in the audit; the created tab is mirrored and `createdByAssist`; Desk sees the tabs change; `tabs.navigate` to `http://127.0.0.1:4175/` answers `denied_url`; `tabs.create { url: 'chrome://settings' }` answers `bad_args`; a `tabs.query { urlHost: '127.0.0.1' }` returns no tab |
| E5 | Assist selects **In-page** (greyed) -> `level.request` with a reason; Desk allows | `level.requested` and `consent.level_changed { opId }`, toggle enabled, a click on the fixture button opens a tab on the Desk; a click on the cross-origin iframe's button answers `not_supported`; `control.input { mode: 'dom' }` aggregated from both reporters. A second request refused by the Desk writes `consent.level_refused` |
| E6 | Deep control: Desk allows (permission pre-granted) | `chrome.permissions.contains({ permissions: ['debugger'] })` true, `chrome.debugger.getTargets()` shows `attached: true` plus a screenshot of the infobar, badge `DBG`, typing lands via CDP; Desk lowers level => detached within 1 s; after **Stop sharing** `permissions.contains` is false |
| E7 | Backstage: consent without the checkbox => `backstage.enter` answers `not_allowed`; Desk enables it in the side panel; open `/form.html` in background, fill a field, bring to front | toast in the active tab with the host; `backstage.enter` pair and `exit { outcome: 'bring_to_front' }`; the Desk's active tab did not change until bring to front; `(+1 background tab)` on the bar meanwhile |
| E8 | Pause this tab, resume | placeholder on the Assist, `mirror.stopped { reason: 'paused' }` then `mirror.started { reason: 'resumed' }` |
| E9 | Kill the data channel (test hook forces `pc.close()` on the Assist without renegotiation) | relay fallback within 5 s, status chip `relayed`, bar text "via server", mirroring continues; after the rebuild (`webrtc.offer { restart: true }`) the chip returns to `direct`; `mirror.relayed` written at end. With `allowRelayFallback: false` the console shows the waiting notice and no `mirror.relay` is accepted |
| E10 | Stop the extension's service worker (`chrome://serviceworker-internals` **Stop** for the extension's worker; `chrome.runtime.reload` is **not** used, it clears `storage.session`) during `active` | resume keeps `active`, a new PC is built (`restart: true`), snapshots re-sent, Assist keeps the replayer and the recorder, audit `session.resumed { toState: 'active' }`; no second consent window |
| E11 | **Stop sharing** from the bar | bars removed, badge cleared, capture script gone (a new tab shows no bar), `mirror.stopped { reason: 'ended' }` with totals and the last `control.input` flush are in the chain **before** `session.ended`, receipt in the side panel with tabs/hosts/level changes/unmasks, Assist ended view |
| E12 | Record for 20 s including a reveal, stop, verify, replay | recording `stored` with mime `application/x-ia-rrweb+jsonl`, verify ok, the file contains a `redacted` line and no input events during the reveal window, replay page plays the tab with the watermark visible; `DELETE /recordings/:id` then makes **Replay** show "deleted" |
| E13 | Heavy fixture | tab marked `too_large`, session continues on the other tab |
| E14 | Accessibility (`@axe-core/playwright`) on the side panel, consent window, popup, options and the P2 console | no `serious` or `critical` violations; keyboard-only run of E1 and E11 |
| E15 | Console served by `vite preview` with `preview.cors = false` (no CORS headers on `/assets/`), and by the nginx image when Docker is available | `/replayer.html` loads and executes inside the sandboxed frame (`rp.ready`), E1's snapshot applies (`rp.applied`); the page made no request to `/assets/` from the frame |
| E16 | Bar self-defence: the fixture removes `ia-indicator` and sets `display:none` on it via a stylesheet | the bar is back within 1 s each time; when the fixture keeps re-removing it every 100 ms the tab is paused within 3 s with `mirror.stopped { reason: 'error' }` |

### 13.3 Smoke script

`scripts/smoke.mjs` gains an **optional** P2 block (`SMOKE_P2=1`) covering the server side only (policy GET/PATCH, retention GET/PATCH, `public-lookup` with `extension` and with a `chrome-extension://` Origin plus `X-Requested-With`, a `desk.hello` with `client.kind: 'extension'` through the tier gate, `desk.consent` with `extension`, `desk.consent_level`, a `desk.event tab.action { host }` whose chain entry carries `hostHash` and no `host`, a `POST /sessions/:id/events tab.action`); it needs no browser. The existing 26 steps stay and remain the default gate.

### 13.4 Bandwidth gate (PRD 13: P2 under 100 kbps typical)

| Item | Rule |
|---|---|
| Scenario A (gated) | fixture `form.html`, 60 s script: type 200 characters across 4 fields, scroll the list end to end twice, click 10 buttons that toggle text, move the mouse continuously at 30 Hz |
| Scenario B (informational) | fixture `spa.html`: 500-row list, type a 10-character filter that re-renders the list on every keystroke, scroll twice, 60 s |
| Measurement | Assist side, `pc.getStats()`: (1) **mirror-only** = `data-channel` entry with `label === 'ia.mirror'`, `bytesReceived` delta between t = 5 s (after the initial snapshot) and t = 65 s, divided by 60 s, times 8 / 1000 = kbps; (2) **total session** = `transport` entry `bytesReceived + bytesSent` over the same window, measured with voice off and with voice on (Opus). Also surfaced live in `MirrorStatus` and in `session.stats.mirrorKbps` / `sessionKbps` (10 s window) |
| Target | Scenario A mirror-only average <= 100 kbps; initial snapshot of `form.html` <= 150 KiB on the wire. Scenario B and the totals are printed, not gated, in Phase B; "typical" in PRD 13 is defined by these two fixtures |
| Gate | Playwright test `bandwidth.spec.ts` fails above the Scenario A target; all four numbers are printed in the CI summary |

### 13.5 Gates per engineer

| Engineer | Must pass before handing over |
|---|---|
| shared/api | `pnpm --filter @indiansassist/shared typecheck test`, `--filter @indiansassist/db typecheck test`, `--filter @indiansassist/api typecheck test`; rebuilt `dist/` for shared and db; `pnpm smoke` still 26 / 26 |
| extension | `pnpm --filter @indiansassist/extension typecheck lint test build`; `dist/` loads unpacked in Chrome 120+ without manifest warnings; `dist/manifest.json` has no wildcard host in `externally_connectable` / bridge `matches`; every file < 400 lines |
| web | `pnpm --filter @indiansassist/web typecheck test build` (both Vite configs; `dist/replayer.html` has no `src=`/`href=` network reference and its meta CSP hash matches the inline script); Phase A tests still green (98+) |
| integration | Spike S0 recorded in §10.2; §13.2 E1-E16 and §13.4 green locally; `docs/LICENSE-REGISTER.md` lists `rrweb` (in use, Phase B, exact version), `@types/chrome`, `@axe-core/playwright`, `eslint-plugin-no-unsanitized`; `infra/.env.example`, `infra/nginx/security-headers.conf` (`frame-src 'self'`) and `infra/nginx/web.conf` (`/replayer.html` location) updated; `pnpm validate:infra` green including the `REGION_ORIGINS` / `VITE_REGION_ORIGINS` / manifest agreement check |

---
## 14. Amendments to Phase A and PRD ambiguities resolved

| # | Text | Phase B position | Why |
|---|---|---|---|
| Y1 | A §2.1 `p2_extension`: "`/join` shows stub; `desk.hello` answers `join_unsupported`" | `/join` renders §2.1; `desk.hello` with `client.kind = 'extension'` joins; a web client on a p2 token still gets `join_unsupported` | Phase B delivers P2 |
| Y2 | A §7.5 Desk resume from `active` -> `consent_pending`; Assist tears down on `desk.reconnected` | kept for `client.kind = 'web'`; extension resume keeps `active` and gets `ice.refresh`; the Desk rebuilds its PC and offers with `restart: true`; the Assist keeps replayer and recorder and rebuilds its PC on that offer (§3.5) | the Phase A reason was the lost capture track; the extension loses nothing on a reconnect, and the consent decision stands; a fresh offer from a new PC cannot be applied to an old one |
| Y3 | A §8 four data channels, A §7.1 64 KiB frames | six channels in P2; the WS frame limit is unchanged, relay payloads are split into parts (§4.6); data-channel frames are fragmented to the SCTP message size (§4.5) | reuse over a new transport |
| Y4 | A §6.10 recording media types | `application/x-ia-rrweb+jsonl` added; one recording per session still | P2 recording is rrweb, not video |
| Y5 | A §5.3 `session.consent_granted { surface }` | optional `level`, `scope`, `backstage` added (present only for P2) | the consent decision must be in the chain, not only in a mutable column |
| Y6 | A §7.3 `desk.event` (`file.*` only) | action union extended; `reason` field for `mask.override`, `mask.refused`, `consent.level_refused`; wire `host`, chain `hostHash` | the extension is the attesting reporter (§3.6) |
| Y7 | A P3 headers on every response | `frame-src 'self'` added to the SPA CSP; `/replayer.html` gets `frame-ancestors https://$host` and no `X-Frame-Options`, with its own hash-based meta CSP | sandboxed replayer must be embeddable by the console and by nothing else |
| Y8 | A §8.2 annotation (Assist draws over a preview of the Desk's own stream) | in P2 annotations carry a required `tabId`, coordinates relative to the tab viewport (`Meta` size), and are drawn by the content script in the mirrored tab | there is no video frame; the tab viewport is the shared surface, so the PRD sentence "the Desk sees it as an overlay" is met literally in P2 |
| Y9 | PRD 3 P2 "all uploaded so the Assist replays the Desk's browser live" | mirror data flows peer to peer over the data channel; the server relays only as a fallback (Y22), never stores it; recording is Assist-side and opt-in | PRD 7 "the relay should never be able to read a session", bandwidth and residency |
| Y10 | Task wording "session.package p2_extension" | the column and wire field remain `tier` (A naming rule) | one name everywhere |
| Y11 | Task wording: data channel labels `mirror`, `control` | `ia.mirror`, `ia.control` | A §8 label convention |
| Y12 | PRD 3 P2 "Side panel: chat, voice, files" and PRD 6 clipboard flow | the side panel is opened by the action click or by the consent **Share** click; token entry lives in the side panel idle view; the join handshake is the primary path (no clipboard write on success), the clipboard the fallback and the J4 install path (§2) | MV3 opens the panel only on a user gesture; PRD 6 says the clipboard is a convenience, not the boundary |
| Y13 | PRD 3 P2 "Firefox second" | Phase B is Chromium only; §9.7 records the port notes | no `offscreen`, `sidePanel`, `debugger`, `externally_connectable` in Firefox |
| Y14 | PRD 4 "Session recording: Yes (rrweb replay)" | recording captures the mirror only (no voice) in Phase B; revealed values are redacted unless `policy.recordRevealed` | one recording per session; audio mixing with rrweb replay is deferred; "show once" must not become "stored forever" |
| Y15 | PRD 12.3 "Auto mask password and marked sensitive fields" | all input values masked by default, `[contenteditable]` too; secrets (ever-password, credential autocompletes) are non-unmaskable and fixed-length masked | privacy by default; a technician who needs a value asks and the Desk decides per field |
| Y16 | Task list of permissions | `alarms` added; `debugger` optional and removed at session end; `notifications` and `downloads` deliberately absent; `activeTab` kept though redundant | keepalive needs alarms; downloads go through `<a download>` in the panel; each session re-prompts at the browser level |
| Y17 | Task: "clipboard read on first open" | the extension never reads the clipboard without the **Paste from clipboard** click, including the first open; the panel reads it, not the worker | visible-consent principle (P3); a worker has no clipboard |
| Y18 | PRD 3 P2 "content script for capture" (static) | the capture script is injected only while a session is `active`, never into deny-listed hosts, per tab under `current_tab`, globally with `excludeMatches` under `all_tabs`, and removed at teardown; only the join bridge is static | P7: nothing of ours runs in the Desk's pages outside a session or in protected pages during one; Web Store review of `<all_urls>` is also easier to justify |
| Y19 | Task: "popup (token paste/connect)" | the popup is a transient window for the join handshake; paste and manual entry live in the side panel idle view (the action click opens the panel, so a `default_popup` would compete with it) | one entry surface; `openPanelOnActionClick` and `default_popup` are mutually exclusive in practice |
| Y20 | Task: "server-side size limits ... NO server persistence except an optional recording mode writing rrweb events to object storage" | the recording is produced by the Assist console and uploaded through the Phase A recordings endpoints; the server stores bytes it never parsed | the server never reads a session (PRD 7); the recording still gets a sha256 in the chain exactly like video |
| Y21 | A §6.1 CSRF ("`Origin` must equal `WEB_ORIGIN`") and A §7.2 WS upgrade Origin check | the REST CSRF rule and the WS upgrade accept `Origin: chrome-extension://<id>` for every id in `EXTENSION_IDS` (dev: any `chrome-extension://` origin when `EXTENSION_IDS` is empty and `NODE_ENV !== 'production'`), **only** for `POST /tokens/public-lookup`, `GET /.well-known/indiansassist.json` and the `/signal` upgrade; `X-Requested-With: IndiansAssist` stays required on REST; an extension-origin socket may send Desk messages only (`assist.hello` => `forbidden`, `4403`). `csrfOk` and the hub's upgrade check take the list (`apps/api/src/plugins/security.ts`, `apps/api/src/signal/hub.ts`) | every extension request carries its own origin; without this the extension can never connect |
| Y22 | PRD §7 "the relay never holds plaintext" | the WS mirror / control relay (§4.6) carries the Desk's DOM (including revealed fields) and the technician's input in plaintext through the signaling server while the data channel is down; never logged or persisted; orgs may refuse it (`policy.allowRelayFallback: false`); the Desk's bars say "via server" | known E2EE gap extending X7, larger in scope; recorded so the PRD owner sees it |
| Y23 | A §7.3 `webrtc.offer { sessionId, sdp }` | + `restart?: boolean`: set by a Desk that built a new `RTCPeerConnection` (resume, or after the third failed recovery); the receiver must rebuild its own PC before applying | perfect negotiation cannot apply a new PC's offer to an old PC |
| Y24 | A §6.8 `POST /sessions/:id/events` (`file.*`, `recording.started`) | action union extended with `tab.action`, `control.input`, `mask.requested`, `level.requested`, `backstage.enter`, `backstage.exit` (actor `user`, `opId`), 10 / s burst 30 per session | dual attestation (§3.7), like `file.*` in Phase A |
| Y25 | A §6.12 WS frame bucket "20 frames / s, burst 60" on every frame | `ping`, `pong`, `session.end` and `desk.consent` are exempt | a Desk pacing relay frames at the limit must not be closed `4408` for a missed heartbeat or lose its final frame |
| Y26 | A §14 "Recording deletion endpoint and retention policies: B" | delivered: `DELETE /recordings/:id`, `org.recording_retention_days`, sweeper deletion, `recording.deleted` in the chain, `recording.deleted_at` | P2 recordings persist page content; DPDP and PRD 12.2 need an end of life for them |
| Y27 | A §6.10 `GET /recordings/:id/download` answers a presigned URL (`RECORDING_DOWNLOAD_ORIGIN`) | `?inline=1` streams the object through the api on the same origin, for in-page replay only | the SPA CSP `connect-src 'self' wss:` and the `/file` route's missing CORS would block `fetch()` on hardened deployments |
| Y28 | A §7.3 `desk.consent_level` family | new `desk.consent_backstage { sessionId, backstage }`, chain `consent.backstage_changed` | background-tab consent is the Desk's, changeable during the session |

### 14.1 Phase A deferrals assigned to Phase B (A §14)

| A §14 item | Decision | Owner / section or reason |
|---|---|---|
| Email delivery for invites, consent receipts and password reset | **re-deferred to Phase E** | no mail transport exists in the dev or Compose stack (PLAN 1); the Desk's receipt is downloadable from the side panel (A D6, §7); invites keep the copy-link flow; goes with SSO in E |
| `POST /api/v1/sessions/:id/accept` and `/deny` (REST acceptance) | **re-deferred to Phase C** | its consumers (mobile controller, PSA) arrive in C/E; the acceptor still needs the live socket for `session.created` (A X1) |
| File transfer streaming to disk above 256 MiB (File System Access API) | **re-deferred to Phase C** | the extension side panel cannot hold a `FileSystemWritableFileStream` across a worker restart reliably; the P3 agent writes to disk natively |
| Recording deletion endpoint and retention policies | **in scope** | shared/api: §11.1, §11.3, Y26; web: delete button and retention setting on the org admin page; integration: E12 |
| Password reset by email | **re-deferred to Phase E** | with email delivery |
| Enrollment tokens joining, `device` writes, P2-P4 clients | P2 client **in scope** (this document); P3/P4 and enrollment stay C/D | |

Deferred from Phase B (tracked in A §14 style): Firefox and Safari builds; `allowRemoteAssets` (remote images in the replayer); org overrides of the built-in deny list; voice in the mirror recording; cross-origin iframe co-browsing; `chrome.storage.managed` rollout docs beyond the schema; supervisor join in P2 sessions; server-side rrweb recording; Web Store publication itself (ids and URLs are env-driven so no code changes when it happens); `policy.followDeskFocus` (auto-follow of the Desk's active tab).

---

## 15. Name index (one definition each; everything else imports)

| Name | Kind | Defined in | Used by |
|---|---|---|---|
| `p2_extension` | tier value (A) | `shared/enums.ts` | all |
| `CONSENT_LEVELS`, `ConsentLevel`, `levelAtLeast` | enum | `shared/enums.ts` | api (gate), extension (ops), web (toggle) |
| `MIRROR_SCOPES`, `MirrorScope`, `FIELD_KINDS`, `MASK_FIXED` | enum / const | `shared/enums.ts` | api, extension, web |
| `DESK_CLIENT_KINDS`, `deskClientSchema` | enum, schema | `shared/enums.ts`, `shared/schemas/signal-messages.ts` | api (tier gate), extension (`desk.hello`) |
| `DATA_CHANNEL_LABELS` (`ia.mirror`, `ia.control`) | const | `shared/enums.ts` | extension (offscreen), web |
| `LIMITS.mirror*`, `LIMITS.control*`, `LIMITS.policy*`, `LIMITS.prompt*`, `LIMITS.reveal*`, `LIMITS.deskEventOutbox*`, `LIMITS.assistEvents*` | limits | `shared/enums.ts` | all |
| `CSRF_HEADER`, `CSRF_HEADER_VALUE` (A) | const | `shared/enums.ts` | extension (every REST call), api |
| `ExtensionPolicy`, `DEFAULT_EXTENSION_POLICY`, `mergePolicy`, `effectiveMaxLevel`, `managedPolicySchema` | schema / function | `shared/extension/policy.ts` | api (REST, `session.created`, consent validation), extension (consent, selector, options), web (admin page, toggle) |
| `BUILTIN_DENY_LIST`, `matchesDenyList`, `isMirrorableUrl`, `normaliseHostPattern`, `denyListToMatchPatterns`, `stripUrlForMirror`, `hostOf` | functions | `shared/extension/deny-list.ts` | api (PATCH validation, `builtinDenyList`, wire `host` check), extension, web (`Meta.href`) |
| `encodeMirrorFrames`, `decodeMirrorFrame`, `MirrorReassembler`, `MIRROR_FRAME_VERSION` | codec | `shared/extension/mirror-frame.ts` | extension (offscreen), web (replayer bridge) |
| `CONTROL_OPS`, `controlRequestSchema`, `controlResponseSchema`, `controlEventSchema`, `controlMessageSchema`, `CONTROL_ERROR_CODES`, `minLevelFor`, `TAB_ACTION_KINDS`, `tabInfoSchema`, `groupInfoSchema`, `windowInfoSchema`, `modifiersSchema`, `opIdFor` | protocol | `shared/extension/control.ts` | extension (worker), web (`controlClient`), api (`control.relay` size and direction check only) |
| `joinHandshakeSchema`, `joinReplySchema`, `extPingSchema`, `extPongSchema`, `extPresentSchema`, `EXT_HANDSHAKE_VERSION`, `EXTENSION_ID_PLACEHOLDER` | handshake | `shared/extension/handshake.ts`, `shared/enums.ts` | web (join page), extension (bridge, `external.ts`) |
| `checkToken`, `parseToken`, `verifyTokenSignature`, `isTokenTimeValid` (A) | token | `shared/token/codec.ts` | extension (local verification, §2.2), api |
| `sanitiseRrwebEvent`, `sanitiseSnapshotNode`, `sanitiseCssText`, `isAllowedUrl` | function | `shared/extension/rrweb-sanitise.ts` | extension (before send), web (before post and inside the frame) |
| `dcMirrorTabsSchema`, `dcMirrorTabSchema`, `dcMirrorAckSchema`, `dcMirrorNackSchema` | data channel | `shared/schemas/datachannel.ts` | extension, web |
| `deskConsentLevelSchema`, `deskConsentBackstageSchema`, `consentLevelOkSchema`, `mirrorRelaySchema`, `controlRelaySchema`, `webrtcOfferSchema.restart` | WS | `shared/schemas/signal-messages.ts` | api, extension, web |
| `deskEventDataSchema(action)`, `assistEventDataSchema(action)`, `auditDataSchema(action)`, `hostToHash` | audit | `shared/audit/actions.ts` | api (`desk.event`, `POST events`, chain), extension and web (self-check before send) |
| `mirror.started`, `mirror.stopped`, `tab.action`, `control.input`, `mask.requested`, `mask.override`, `mask.refused`, `mask.restored`, `level.requested`, `consent.level_refused`, `consent.level_changed`, `consent.backstage_changed`, `backstage.enter`, `backstage.exit`, `mirror.relayed`, `org.policy_updated`, `recording.deleted` | audit actions | `shared/audit/actions.ts` | api, web (audit tab labels, pairing) |
| `application/x-ia-rrweb+jsonl`, `recordingFileExtension` | media type | `shared/schemas/rest-sessions.ts` | api (recordings), web (recorder, replay) |
| `PublicToken.extension` | REST | `shared/schemas/rest-tokens.ts` | api, web (join page), extension (lookup) |
| `EXTENSION_IDS` | env | `apps/api` config | api (Y21 Origin allow-list, `PublicToken.extension.ids`) |
| `REGION_ORIGINS` (compiled) | const | `apps/extension/src/shared/constants.ts` (from `VITE_REGION_ORIGINS` at build) | extension only (handshake, options, manifest generation) |
| `CDP_ALLOWED_METHODS`, `sendCommand` | const / function | `apps/extension/src/background/debugger-control.ts` | extension only |
| `assertNavigableUrl` | function | `apps/extension/src/background/tabs-control.ts` | extension only |
| `ExtensionPhase`, `EXTENSION_PHASES`, `UiState`, `Receipt`, bus message types (with `to`), storage keys | extension-local | `apps/extension/src/shared/constants.ts`, `bus.ts`, `storage.ts` | extension only |
| `rp.*` replayer protocol, `replayerMessageSchema` | web-local | `apps/web/src/assist/console/mirror/replayerProtocol.ts` | web only (parent and `src/replayer/main.ts`) |
