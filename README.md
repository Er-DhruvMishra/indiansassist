# IndiansAssist

Remote support and remote access platform. Self hostable, source available, security by default.

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
