/** Shared fixtures for the session machine tests: a machine on the fake WS and the walk to consent / active. */
import { expect, vi } from 'vitest';
import { DEFAULT_EXTENSION_POLICY } from '@indiansassist/shared';
import { handleUiCommand } from '../src/background/commands';
import { LiveSession } from '../src/background/live-session';
import { SessionMachine } from '../src/background/session-machine';
import { EXT_ID } from './chrome-mock';
import { FakeWS } from './fake-ws';

export const ORIGIN = 'https://in.indiansassist.example';
export const SID = '00000000-0000-4000-8000-000000000010';
export const UUID = '00000000-0000-4000-8000-000000000001';
export const ASSIST = { id: '00000000-0000-4000-8000-000000000002', name: 'Asha' };
export const ORG = { displayName: 'Acme', accentColor: null, logoData: null };
export const TS = '2030-01-01T00:00:00.000Z';
export const ICE = { t: 'ice.refresh', sessionId: SID, iceServers: [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'c' }], iceTtl: 600, iceExpiresAt: TS };

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export function lookupFetch() {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          tokenId: UUID,
          tier: 'p2_extension',
          typ: 'one_time',
          expiresAt: TS,
          region: 'in-mum',
          org: { ...ORG, supportEmail: null },
          technician: { name: 'Asha' },
          signalUrl: 'wss://in.indiansassist.example/signal',
          joinSupported: true,
          extension: null,
        }),
        { status: 200 },
      ),
  );
}

export function created(state: 'consent_pending' | 'active', policy = DEFAULT_EXTENSION_POLICY) {
  return { t: 'session.created', sessionId: SID, tokenId: UUID, tier: 'p2_extension', state, consentState: state === 'active' ? 'granted' : 'pending', assist: ASSIST, desk: { label: 'Desk' }, org: ORG, polite: false, extension: { policy } };
}

export function helloOk(resume?: 'active' | 'consent_pending') {
  return { t: 'desk.hello.ok', connectionId: 'c1', tokenId: UUID, tier: 'p2_extension', technician: { name: 'Asha' }, org: ORG, region: 'in-mum', ...(resume ? { resume: { sessionId: SID, state: resume, consentState: resume === 'active' ? 'granted' : 'pending' } } : {}) };
}

export function machine(openWindow: (url: string, w: number, h: number) => Promise<number | null>): SessionMachine {
  const m = new SessionMachine({ extensionId: EXT_ID, WebSocketImpl: FakeWS as unknown as typeof WebSocket, fetch: lookupFetch(), openWindow });
  m.liveFactory = (x) => new LiveSession(x);
  return m;
}

/** idle -> consent_pending (the consent window is open). */
export async function toConsent(m: SessionMachine): Promise<FakeWS> {
  expect(await m.join('482193657710', ORIGIN)).toEqual({ ok: true, state: 'connecting' });
  const ws = FakeWS.last();
  ws.open();
  ws.recv(helloOk());
  ws.recv({ t: 'knock.ok', sessionId: SID, resumeKey: 'rk-1', expiresAt: TS });
  ws.recv(created('consent_pending'));
  await tick(5);
  return ws;
}

export async function toActive(m: SessionMachine, scope: 'current_tab' | 'all_tabs' = 'current_tab', level: 'tab_control' | 'in_page' | 'deep_control' = 'tab_control'): Promise<FakeWS> {
  const ws = await toConsent(m);
  await handleUiCommand(m, { to: 'worker', t: 'ui.consent', decision: 'share', level, scope, backstage: false, tabId: 1 });
  ws.recv({ t: 'consent.ok', sessionId: SID, state: 'active', consentState: 'granted', iceServers: [{ urls: 'stun:stun.example:3478' }] });
  await tick(20);
  return ws;
}
