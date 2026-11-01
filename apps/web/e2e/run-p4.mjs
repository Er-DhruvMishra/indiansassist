#!/usr/bin/env node
// Cross-platform launcher for the Package 4 (fleet console accessibility) e2e: sets E2E_P4 so the shared Playwright
// config picks the P4 suite, its own PGlite directory and SIGNUP_PLAN_TIER=p4_installed, then runs Playwright.
// Keeping the env here (instead of an inline VAR=... prefix) means the same command works on Windows cmd,
// PowerShell and bash.
//
//   pnpm e2e:p4                      # apps/web/e2e/package4.spec.ts
//   E2E_API_PORT=4300 pnpm e2e:p4    # move the API off :4000 when it is busy
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, E2E_P4: '1' };
const r = spawnSync('pnpm', ['exec', 'playwright', 'test'], { cwd: webRoot, env, stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
