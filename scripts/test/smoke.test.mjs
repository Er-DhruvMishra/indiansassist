// Runs scripts/smoke.mjs end to end against the in-process fake api, plus fault injection: a tampered audit
// entry, a server that relays SDP before consent, and an unreachable api must all make the smoke FAIL.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runSmoke } from '../smoke.mjs';
import { loadShared } from '../smoke/shared.mjs';
import { startFakeApi } from './fake-api.mjs';

let shared;
let api;
const lines = [];
const log = (l) => lines.push(l);

beforeAll(async () => {
  shared = await loadShared();
});

afterEach(async () => {
  lines.length = 0;
  await api?.close();
  api = undefined;
});

const statusOf = (run, prefix) => run.results.find((r) => r.name.startsWith(prefix))?.status;

describe('smoke against a contract-conforming fake api', () => {
  it('passes every step and prints PASS lines', async () => {
    api = await startFakeApi(shared);
    const run = await runSmoke({ apiUrl: api.url, log, timeoutMs: 3000 });
    const failures = run.results.filter((r) => r.status !== 'PASS');
    expect(failures, lines.join('\n')).toEqual([]);
    expect(run.ok).toBe(true);
    expect(run.results.length).toBeGreaterThanOrEqual(22);
    expect(lines.some((l) => l.startsWith('PASS  GET /api/v1/sessions/:id/audit'))).toBe(true);
    expect(lines.at(-1)).toMatch(/-> PASS$/);
    // The fake marked the token used on consent, and the session ended with the assist.
    const session = [...api.state.sessions.values()][0];
    expect(session.state).toBe('ended');
  });
});

describe('smoke detects contract violations', () => {
  it('fails the session audit step when an entry was tampered with', async () => {
    api = await startFakeApi(shared, { tamperAudit: true });
    const run = await runSmoke({ apiUrl: api.url, log, timeoutMs: 3000 });
    expect(run.ok).toBe(false);
    expect(statusOf(run, 'GET /api/v1/sessions/:id/audit')).toBe('FAIL');
    const detail = run.results.find((r) => r.name.startsWith('GET /api/v1/sessions/:id/audit')).detail;
    expect(detail).toMatch(/hash mismatch/);
  });

  it('fails the media gate when SDP is relayed before consent (hard rule 1)', async () => {
    api = await startFakeApi(shared, { leakOfferBeforeConsent: true });
    const run = await runSmoke({ apiUrl: api.url, log, timeoutMs: 1500 });
    expect(run.ok).toBe(false);
    expect(statusOf(run, 'media gate')).toBe('FAIL');
    // Critical failure: later steps are skipped, not silently passed.
    expect(statusOf(run, 'assist session.end')).toBe('SKIP');
  });

  it('fails fast and skips the rest when the api is unreachable', async () => {
    const run = await runSmoke({ apiUrl: 'http://127.0.0.1:9', log, timeoutMs: 500 });
    expect(run.ok).toBe(false);
    expect(statusOf(run, 'GET /api/v1/health')).toBe('FAIL');
    expect(run.results.filter((r) => r.status === 'SKIP').length).toBeGreaterThan(10);
  });
});
