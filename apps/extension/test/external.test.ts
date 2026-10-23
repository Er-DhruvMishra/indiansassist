import { describe, expect, it, vi } from 'vitest';
import { handleHandshake, senderOrigin } from '../src/background/external';
import { bridgeAccepts } from '../src/content/bridge';
import { EXTENSION_VERSION, REGION_ORIGINS } from '../src/shared/constants';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = 'https://in.indiansassist.example';

function deps() {
  return { extensionId: ID, join: vi.fn(async () => ({ ok: true as const, state: 'connecting' as const })), onOriginRefused: vi.fn() };
}

describe('join handshake (section 2.2)', () => {
  it('the compiled list holds exact origins (dev build adds the local web origins)', () => {
    expect(REGION_ORIGINS).toContain(ORIGIN);
    expect(REGION_ORIGINS.every((o) => !o.includes('*') && new URL(o).origin === o)).toBe(true);
  });

  it('an allow-listed sender starts the join with apiOrigin = the sender origin', async () => {
    const d = deps();
    const reply = await handleHandshake({ t: 'ia.join', v: 1, code: '482193657710' }, ORIGIN, d);
    expect(reply).toEqual({ ok: true, state: 'connecting' });
    expect(d.join).toHaveBeenCalledWith('482193657710', ORIGIN);
  });

  it('any extra key (a page naming a server) answers version and joins nothing', async () => {
    const d = deps();
    for (const extra of [{ signalUrl: 'wss://evil.example/signal' }, { apiUrl: 'https://evil.example' }, { region: 'in-mum' }]) {
      expect(await handleHandshake({ t: 'ia.join', v: 1, code: '482193657710', ...extra }, ORIGIN, d)).toEqual({ ok: false, error: 'version' });
    }
    expect(await handleHandshake({ t: 'ia.join', v: 2, code: 'x' }, ORIGIN, d)).toEqual({ ok: false, error: 'version' });
    expect(d.join).not.toHaveBeenCalled();
  });

  it('a sibling subdomain, another port or scheme answers origin and is counted', async () => {
    const d = deps();
    for (const o of ['https://evil.indiansassist.example', 'https://in.indiansassist.example:444', 'http://in.indiansassist.example', null]) {
      expect(await handleHandshake({ t: 'ia.join', v: 1, code: '482193657710' }, o, d)).toEqual({ ok: false, error: 'origin' });
    }
    expect(d.onOriginRefused).toHaveBeenCalledTimes(4);
    expect(d.join).not.toHaveBeenCalled();
  });

  it('answers a ping with a pong carrying version and id; ignores unrelated messages', async () => {
    expect(await handleHandshake({ t: 'ia.ext.ping', v: 1 }, ORIGIN, deps())).toEqual({ t: 'ia.ext.pong', version: EXTENSION_VERSION, id: ID });
    expect(await handleHandshake({ t: 'something' }, ORIGIN, deps())).toBeUndefined();
  });

  it('reads the origin from the browser-supplied sender, never from the message', () => {
    expect(senderOrigin({ origin: ORIGIN, url: 'https://evil.example/x' })).toBe(ORIGIN);
    expect(senderOrigin({ url: `${ORIGIN}/join#t=abc` })).toBe(ORIGIN);
    expect(senderOrigin({ origin: 'null' })).toBeNull();
    expect(senderOrigin(undefined)).toBeNull();
  });

  it('the bridge forwards only page-own messages from a compiled origin', () => {
    const win = {} as Window;
    expect(bridgeAccepts({ source: win, origin: ORIGIN, data: { t: 'ia.join' } }, win)).toBe(true);
    expect(bridgeAccepts({ source: {}, origin: ORIGIN, data: { t: 'ia.join' } }, win)).toBe(false);
    expect(bridgeAccepts({ source: win, origin: 'https://evil.example', data: { t: 'ia.join' } }, win)).toBe(false);
    expect(bridgeAccepts({ source: win, origin: ORIGIN, data: { t: 'ia.join.reply' } }, win)).toBe(false);
  });
});
