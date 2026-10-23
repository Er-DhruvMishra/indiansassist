# IndiansAssist browser extension (Package 2, Desk side)

Chrome / Edge MV3 extension that lets an employee share chosen browser tabs with an IT technician. It mirrors the
DOM of the shared tabs with rrweb (never pixels, never the whole screen) over a WebRTC data channel, and lets the
technician act inside the browser only, at a level the employee picked. The binding spec is
`docs/specs/phase-b-contracts.md` (sections 2-9, 12, 13).

Vocabulary: **Desk** = the employee's browser (this extension), **Assist** = the technician console (`apps/web`).

## Build

```sh
pnpm install
pnpm --filter @indiansassist/shared build          # the extension imports shared from dist/
pnpm --filter @indiansassist/extension build        # dist/ = the unpacked extension
```

- Dev build (default when `VITE_REGION_ORIGINS` is empty): accepts the join handshake from `http://localhost:5173`
  and `http://127.0.0.1:5173`, sends REST calls to `VITE_API_URL` (default `http://localhost:4000`).
- Production build: `VITE_REGION_ORIGINS="in-mum=https://in.example.com,eu-fra=https://eu.example.com" pnpm --filter @indiansassist/extension build`.
  The build fails when the list is empty, holds a wildcard, a path, or a non-https origin.
- `pnpm --filter @indiansassist/extension dev` rebuilds on change; reload the extension on `chrome://extensions`.
- Other variables: see `.env.example` (`EXTENSION_KEY` pins the unpacked id so the api can list it in `EXTENSION_IDS`).

## Load unpacked

1. Build as above.
2. Open `chrome://extensions` (Edge: `edge://extensions`) and turn on **Developer mode**.
3. **Load unpacked** and select `apps/extension/dist`.
4. Pin the IndiansAssist icon. Clicking it opens the side panel.
5. Run the stack (`pnpm dev`: api on :4000, web on :5173), create a **Package 2** token in the console and open its
   join link: the page detects the extension and offers **Open in extension**. Alternatively paste the code in the
   side panel (**Paste from clipboard** or the code field).
6. When the api runs with an empty `EXTENSION_IDS` in development it accepts any `chrome-extension://` origin;
   in production list the extension id there.

Chrome 120 or newer is required (`minimum_chrome_version`).

## Permissions and why

| Permission | Why |
|---|---|
| `tabs`, `tabGroups` | list, open, switch, pin, mute, move, group and close tabs when the technician is allowed to (level "switch and open tabs") and show titles in the consent tab picker |
| `sidePanel` | the side panel: code entry, chat, voice, files, the tab list, the Stop button |
| `storage` | session state in `storage.session` (cleared when the browser closes, not readable by pages); only the chosen server, your name, published signing keys and diagnostics are kept in `storage.local`; `storage.managed` reads your employer's policy |
| `scripting` | injects the capture script into shared tabs only, only during a session, never on protected sites, and removes it at the end |
| `activeTab` | kept as the task requires (`<all_urls>` already covers it) |
| `offscreen` | a hidden extension page holds the WebRTC connection and the microphone (a service worker cannot) |
| `clipboardRead` | **Paste from clipboard** reads the clipboard only when you click that button |
| `alarms` | a 30 s keepalive while a session exists |
| `<all_urls>` host permission | mirror any site you choose to share, fetch cross-origin stylesheets and favicons for the mirror, and reach the IndiansAssist server |
| `debugger` (optional) | only for **Deep control**: requested when you choose it, Chrome shows its own "started debugging this browser" bar, only three input methods are ever sent, and the permission is removed again at the end of every session |

Not requested: `notifications`, `downloads`, `history`, `cookies`, `webRequest`. Incognito is not allowed.

## What the employee always sees

- The toolbar badge (`ON`, `DBG` with deep control, `...` while connecting) and a live icon.
- A bar at the top of every shared tab ("Shared with <technician> (<org>)", Pause this tab, Stop sharing, recording,
  deep control and revealed chips). The bar defends itself; if a page keeps hiding it, the tab is paused.
- `(Shared)` in front of the tab title (organisation policy may turn this one off).
- Every request above the current level, every attach of another tab and every unmask request is a prompt with
  the technician's reason; nothing changes without the employee's click.

## Privacy defaults

Every input value is masked; passwords (and fields that were ever passwords), card numbers and one-time codes are
masked to a fixed 8 characters and can never be revealed; `[data-ia-sensitive]` and `[contenteditable]` text is
masked; `[data-ia-block]` is never captured; identity providers, Indian net banking / UPI and password managers
(plus the organisation's and employer's lists) are never mirrored. Mirrored events are sanitised
(`sanitiseRrwebEvent`) before they leave the browser.

## Layout

| Path | Context |
|---|---|
| `src/background/` | service worker: session state machine, `/signal` client, consent gate, tab / group / window ops, debugger allow-list, attestation outbox, injection, badge |
| `src/offscreen/` | peer connection, six data channels, mirror framing and backpressure, relay pacer, files, voice, stylesheet fetch |
| `src/content/` | capture script (`content.js`: rrweb record, batcher, bar, input replay, reveals) and the join bridge (`bridge.js`) |
| `src/sidepanel/`, `src/popup/`, `src/consent/`, `src/options/` | extension pages (vanilla TS, `textContent` only) |
| `src/shared/` | bus, storage keys, compiled constants, join input parsing, file transfer primitives |
| `scripts/` | two-pass Vite build, manifest generation and validation, icon generator |

## Scripts

`build`, `dev`, `typecheck`, `lint` (bans `innerHTML` and friends, `eval`, and `chrome.debugger.sendCommand`
outside the allow-list wrapper), `test` (vitest; jsdom for content-script tests, an in-memory `chrome` fake in
`test/chrome-mock.ts`), `icons` (regenerates `icons/`), `e2e` (Playwright, `test/e2e/`: builds `dist-e2e/` with
`IA_E2E=1`, starts the api, the web dev server and the fixture server on :4175, loads the unpacked extension into a
persistent Chromium context and drives a whole session against a second Chromium running the console; run it from the
repo root with `pnpm e2e:ext`, ports 4000, 5173 and 4175 free or `E2E_API_PORT=4100`). `IA_OUT_DIR` changes the build
output directory (default `dist`).
