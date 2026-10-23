import { describe, expect, it } from 'vitest';
import {
  EXT_HANDSHAKE_VERSION,
  EXTENSION_ID_PLACEHOLDER,
  extPingSchema,
  extPongSchema,
  extPresentSchema,
  joinHandshakeSchema,
  joinReplySchema,
} from '../src/index.js';

describe('extension handshake', () => {
  it('ia.join is strict { t, v, code }', () => {
    expect(joinHandshakeSchema.safeParse({ t: 'ia.join', v: 1, code: 'ia1.x' }).success).toBe(true);
    expect(joinHandshakeSchema.safeParse({ t: 'ia.join', v: 1, code: 'ia1.x', signalUrl: 'wss://evil.test' }).success).toBe(false);
    expect(joinHandshakeSchema.safeParse({ t: 'ia.join', v: 2, code: 'ia1.x' }).success).toBe(false);
    expect(joinHandshakeSchema.safeParse({ t: 'ia.join', v: 1, code: '' }).success).toBe(false);
    expect(EXT_HANDSHAKE_VERSION).toBe(1);
  });
  it('replies over both carriers', () => {
    expect(joinReplySchema.safeParse({ ok: true, state: 'connecting' }).success).toBe(true);
    expect(joinReplySchema.safeParse({ source: 'ia-ext', t: 'ia.join.reply', ok: false, error: 'busy' }).success).toBe(true);
    expect(joinReplySchema.safeParse({ ok: false, error: 'nope' }).success).toBe(false);
    expect(joinReplySchema.safeParse({ ok: true, state: 'connecting', extra: 1 }).success).toBe(false);
  });
  it('ping, pong and present', () => {
    expect(extPingSchema.safeParse({ t: 'ia.ext.ping', v: 1 }).success).toBe(true);
    expect(extPongSchema.safeParse({ t: 'ia.ext.pong', version: '0.2.0', id: EXTENSION_ID_PLACEHOLDER }).success).toBe(true);
    expect(extPongSchema.safeParse({ t: 'ia.ext.pong', version: '0.2.0', id: 'not-an-id' }).success).toBe(false);
    expect(extPresentSchema.safeParse({ source: 'ia-ext', t: 'ia.ext.present', version: '0.2.0', id: EXTENSION_ID_PLACEHOLDER }).success).toBe(true);
    expect(extPresentSchema.safeParse({ source: 'page', t: 'ia.ext.present', version: '0.2.0', id: EXTENSION_ID_PLACEHOLDER }).success).toBe(false);
  });
});
