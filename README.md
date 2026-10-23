# IndiansAssist

Remote support and remote access platform. Self hostable, source available, security by default.

- Product contract: [docs/PRD.md](docs/PRD.md)
- Development plan: [docs/PLAN.md](docs/PLAN.md)
- Decisions: [docs/adr/](docs/adr/)

Vocabulary: **Desk** = the computer being helped. **Assist** = the technician console.

## Quick start (dev)

Needs Node 22 and pnpm 11. No Docker, Postgres or Redis: in dev the api uses embedded PGlite and the local
filesystem under `./data/` (created on first start, together with the dev cookie secret and token signing key).

```
pnpm install
pnpm build      # builds packages/shared and packages/db first; the apps import their dist/ output
pnpm dev        # api on :4000 (metrics on :9464), web on :5173
pnpm smoke      # in a second terminal: end-to-end check against the running api (26 steps)
```

Checks: `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm test:scripts`, `pnpm validate:infra`.
Configuration: `apps/api/.env.example` (copy to `.env` at the repo root) and `apps/web/.env.example`; every
variable has a dev default, so none is needed for local development.

## Self host

See [infra/README.md](infra/README.md).
