# IndiansAssist

Remote support and remote access platform. Self hostable, open source (AGPL-3.0-only), security by default.

- Product contract: [docs/PRD.md](docs/PRD.md)
- Development plan: [docs/PLAN.md](docs/PLAN.md)
- Decisions: [docs/adr/](docs/adr/)

Vocabulary: **Desk** = the computer being helped. **Assist** = the technician console.

## Quick start (dev)

Needs Node 22 (22.18 or newer: `pnpm validate:infra` imports the extension's `manifest.ts` directly) and pnpm 11.
No Docker, Postgres or Redis: in dev the api uses embedded PGlite and the local filesystem under `./data/` (created
on first start, together with the dev cookie secret and token signing key).

```
pnpm install
pnpm build      # packages/shared and packages/db first (the apps import their dist/), then api, web and the extension
pnpm dev        # api on :4000 (metrics on :9464), web on :5173
pnpm smoke      # in a second terminal: end-to-end check against the running api (26 steps)
pnpm smoke:p2   # Package 2 server-side flow (14 steps); `SMOKE_P2=1 pnpm smoke` runs both (40 steps)
```

`API_URL=http://localhost:4100 pnpm smoke` points the smoke scripts at another api.

### Package 2: the browser extension (Desk side)

`pnpm build` also builds the Chrome MV3 extension into `apps/extension/dist` (a dev build: it trusts the join page
on `http://localhost:5173` and sends REST calls to `http://localhost:4000`; see `apps/extension/.env.example`).

1. Open `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode**, **Load unpacked** and pick
   `apps/extension/dist`. Chrome 120 or newer.
2. In the console (`http://localhost:5173`), sign up, give your own seat the **P2 Extension** tier on **Users**,
   then create a **P2 Extension** token on the dashboard.
3. On the Desk, open the join link (the page offers **Open in extension**), or click the extension icon and paste
   the link or the code into the side panel.
4. Accept the knock in the console; the extension opens its consent window; choose the tab and the level, **Share**.

With `EXTENSION_IDS` empty the dev api accepts any `chrome-extension://` origin; in production list the extension
ids there. More in [apps/extension/README.md](apps/extension/README.md).

### Checks

```
pnpm -r typecheck
pnpm -r lint
pnpm -r test
pnpm test:scripts
pnpm validate:infra
```

### End-to-end (Playwright, real Chromium)

```
pnpm --filter @indiansassist/web e2e:install   # once: downloads Playwright's Chromium
pnpm e2e        # Package 1: two browser contexts, screen share, chat, file, annotation, recording, audit
pnpm e2e:ext    # Package 2: the unpacked extension in a persistent Chromium context + an Assist browser
```

Both start their own api (fresh PGlite under `./data/e2e` or `./data/e2e-ext`, rate limits off) and the Vite dev
server, so ports 4000 and 5173 must be free (stop `pnpm dev` first). `E2E_API_PORT=4100` moves the api when :4000
is taken. `pnpm e2e:ext` also builds the extension into `apps/extension/dist-e2e` and serves the fixture pages of
`apps/extension/test/fixtures` on :4175; its bandwidth gate (contract 13.4) runs three 60 s windows, and
`E2E_BW_SECONDS=15` shortens them for a quick local run (not the gate). `E2E_HEADED=1` shows the browsers. Screenshots land in
`apps/web/e2e/artifacts/` and `apps/extension/test/e2e/artifacts/`.

Configuration: `apps/api/.env.example` (copy to `.env` at the repo root), `apps/web/.env.example` and
`apps/extension/.env.example`; every variable has a dev default, so none is needed for local development.

### Package 3: the portable agent (Rust) and the Android host (Phase C, in progress)

Contract: [docs/specs/phase-c-contracts.md](docs/specs/phase-c-contracts.md). Rust 1.99 via rustup on the
`x86_64-pc-windows-gnu` dev target (release builds are `-msvc` in CI only); the Android host needs the Android SDK
(the Gradle wrapper in `apps/android` downloads Gradle).

```
pnpm agent:build       # cargo build of the agent/ workspace (all features; MSVC host)
pnpm agent:build:dev   # release build of the dev console binary (adds --synthetic-capture / --auto-consent / ...)
pnpm agent:test        # cargo test, incl. the two-peer webrtc loopback and ia-core cross-language vectors
pnpm agent:clippy      # clippy -D warnings
pnpm agent:release     # signed-shape release build (default features; GUI-subsystem exe)
pnpm agent:fixtures    # the generated name fixtures are current (rebuild packages/shared first)
pnpm android:test      # Gradle testDebugUnitTest
pnpm android:build     # Gradle assembleDebug
pnpm smoke:p3          # Package 3 server-side flow; start the api with SIGNUP_PLAN_TIER=p3_portable
pnpm e2e:p3            # Package 3 browser-vs-agent e2e (builds the dev binary, spawns it as the Desk)
node scripts/seed-playbooks.mjs   # starter playbooks for an org created before Phase C (SEED_EMAIL / SEED_PASSWORD)
```

The api serves the P3 side of the contract: the download grant (`GET /api/v1/download/manifest`, `POST
/api/v1/download/prepare`, `GET|HEAD /api/v1/download/:grant`, builds from `AGENT_DIST_DIR`; outside production a
placeholder file, `AGENT_DEV_STUB`, stands in for the Windows builds so the join page and `smoke:p3` work locally),
the signed `.iaconfig` sidecar, the native `desk.hello` (Origin-less socket, desk codes, resume, elevation
hand-over), `desk.consent.native`, the P3 level family, playbooks (`/api/v1/orgs/current/playbooks` and the run
endpoint) with the starter catalogue of `scripts/playbooks`, the agent policy (`requireSasConfirm`) and the server
recorder on P3 sessions. The console mounts `AgentConsole` for `p3_portable` sessions and the join page has the
download branch. Start the api with `SIGNUP_PLAN_TIER=p3_portable` (and `RECORDER_TOKEN` for the recorder cases)
and `pnpm smoke:p3` walks the whole native path with a Node client playing the agent (12 steps).

Every Phase C wire name is defined once in `@indiansassist/shared` (`src/agent/*`, `enums.ts`, `files.ts`). The
cross-language fixtures under `packages/shared/test/fixtures/agent/` (`sec-vectors.json` for the `ia.sec` handshake
and frames, `agent-names.json`, `file-lists.json`) are loaded by the TypeScript, Rust and Kotlin tests, so the three
implementations are checked byte for byte against one file. Regenerate them with
`node apps/android/tools/gen-phase-c-vectors.mjs` and `node scripts/gen-agent-fixtures.mjs`.

The agent's `media` build (webrtc-rs, libvpx, egui) compiles and links on the MSVC host; the two-peer webrtc
loopback (`agent/crates/ia-agent/tests/loopback.rs`) negotiates, completes the `ia.sec` handshake with a matching
SAS and carries a VP8 keyframe between two real peers. The dev console binary (`pnpm agent:build:dev`) accepts
`--api-origin`, `--synthetic-capture`, `--auto-consent <level>`, `--no-self-delete` and `--stop-after <secs>`, and
the `pnpm e2e:p3` harness (`apps/web/e2e/package3.spec.ts` + `agent-harness.ts`, a P3 branch of
`playwright.config.ts`) signs up a p3_portable org, mints a token and spawns the binary as the Desk.

What does not work yet: the agent's **live serve loop past `session.created`** is not wired — the real
offer/answer/ICE exchange with the console, the data-channel decrypt-and-serve loops (`ia.control` -> SendInput /
clipboard, `ia.chat`, `ia.files`, `ia.playbook`), the `agent.stats` timer, the DXGI capture and the egui event
loop — so a real agent does not yet complete a session against the api and `pnpm e2e:p3` is not green yet (it runs
through the knock; the steps after accept wait on the serve loop). The decision logic for every one of those is an
implemented, tested `ia-core` / `ia-agent` module (see `agent/README.md` "implemented vs stubbed"). The P3 console
also has no voice or Assist-side recording; nginx does not yet set `proxy_buffering off` for `/api/v1/download/`.
See docs/PLAN.md section 7.

### Server-side recorder (Phase A.2, Go)

`services/recorder` is a headless pion/webrtc peer of the **Desk** that writes a WebM of the shared screen (and the
Desk microphone) to disk and uploads it with its sha256 into the audit chain, so a durable recording does not depend
on the technician's browser. Contract: [docs/specs/phase-a2-recorder.md](docs/specs/phase-a2-recorder.md). It needs
Go 1.27.

```
pnpm recorder:test     # go vet ./... and go test ./... in services/recorder
pnpm recorder:build    # binary in ./data/recorder-bin/
```

Run it locally against `pnpm dev`: start the api with a service token (`RECORDER_TOKEN=<32+ chars>` in `.env`),
then `RECORDER_TOKEN=<same> ./data/recorder-bin/recorder` (defaults: `API_URL=http://localhost:4000`,
`OUT_DIR=./data/recorder`, `/healthz` and `/metrics` on `:9470`). An org admin turns it on with
`PATCH /api/v1/orgs/current/policy/recording { "recordingMode": "server" | "both" }`; the Desk consent screen then
says that the server records. `RECORDER_TOKEN=<same> pnpm smoke:recorder` checks the signaling, upload and audit
path against a running api with a Node client acting as the recorder (no media). In Compose the recorder is the
`recorder` profile: `docker compose --profile recorder up -d` (env in `infra/.env.example`).

## Self host

See [infra/README.md](infra/README.md).

## Licence and policies

- **Licence:** GNU Affero General Public License, version 3 only (AGPL-3.0-only): [LICENSE](LICENSE),
  [NOTICE](NOTICE). Copyright (C) 2026 Dhruv Mishra. If you run a modified version as a network service, section 13
  requires you to offer its source to your users; the web app's footer link (`VITE_SOURCE_URL`) does that.
- **Third-party components** keep their own licences: [docs/LICENSE-REGISTER.md](docs/LICENSE-REGISTER.md), with the
  AGPL compatibility audit at its end.
- **Privacy policy:** [PRIVACY.md](PRIVACY.md). **Code signing policy:** [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md).
  **Security reports:** [SECURITY.md](SECURITY.md) (private vulnerability reporting, never public issues).
  **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md).
- **Website:** <https://indiansassist.com>, built from [site/](site/) (see [site/README.md](site/README.md)).
  Downloads: [GitHub Releases](https://github.com/Er-DhruvMishra/indiansassist/releases).
