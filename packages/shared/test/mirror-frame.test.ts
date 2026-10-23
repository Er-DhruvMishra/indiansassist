import { describe, expect, it } from 'vitest';
import {
  decodeMirrorFrame,
  deflatePayload,
  encodeMirrorFrames,
  inflatePayload,
  isMirrorMessage,
  MIRROR_FRAME_VERSION,
  MirrorReassembler,
  utf8Decode,
  utf8Encode,
} from '../src/index.js';

const json = (n: number) => utf8Encode(JSON.stringify(Array.from({ length: n }, (_, i) => ({ type: 3, timestamp: i, data: { source: 1 } }))));

describe('mirror frame codec', () => {
  it('encodes a small payload in one part with the binary header', () => {
    const payload = utf8Encode('[]');
    const [buf, ...rest] = encodeMirrorFrames({ kind: 'snapshot', tabId: 12, seq: 0, rawLength: 2, payload, deflate: false });
    expect(rest).toHaveLength(0);
    const v = new DataView(buf!);
    expect(v.getUint8(0)).toBe(MIRROR_FRAME_VERSION);
    expect(v.getUint8(1)).toBe(2);
    expect(v.getUint32(4)).toBe(12);
    expect(v.getUint16(12)).toBe(1);
    expect(v.getUint16(14)).toBe(1);
    const d = decodeMirrorFrame(buf!);
    expect(d.ok && d.header).toMatchObject({ kind: 'snapshot', tabId: 12, seq: 0, part: 1, parts: 1, rawLength: 2, deflate: false });
  });

  it('fragments into N parts and reassembles in and out of order', () => {
    const payload = json(400);
    const parts = encodeMirrorFrames({ kind: 'batch', tabId: 7, seq: 3, rawLength: payload.length, payload, deflate: false, chunkBytes: 1000 });
    expect(parts.length).toBe(Math.ceil(payload.length / 1000));
    for (const order of [parts, [...parts].reverse()]) {
      const r = new MirrorReassembler();
      let out = null;
      for (const p of order) out = r.push(p, 0);
      expect(isMirrorMessage(out)).toBe(true);
      if (isMirrorMessage(out)) {
        expect(utf8Decode(out.payload)).toBe(utf8Decode(payload));
        expect(out).toMatchObject({ tabId: 7, seq: 3, kind: 'batch' });
      }
      expect(r.size).toBe(0);
    }
  });

  it('a missing part times out as a gap', () => {
    const payload = json(200);
    const parts = encodeMirrorFrames({ kind: 'batch', tabId: 1, seq: 9, rawLength: payload.length, payload, deflate: false, chunkBytes: 500 });
    const r = new MirrorReassembler(2000);
    for (const p of parts.slice(1)) expect(r.push(p, 1000)).toBeNull();
    expect(r.expire(2500)).toEqual([]);
    expect(r.expire(3000)).toEqual([{ tabId: 1, kind: 'batch', seq: 9, reason: 'timeout' }]);
  });

  it('refuses over 256 parts and declared lengths over 8 MiB', () => {
    expect(() => encodeMirrorFrames({ kind: 'batch', tabId: 1, seq: 1, rawLength: 300, payload: new Uint8Array(300), deflate: false, chunkBytes: 1 })).toThrow(/parts/);
    expect(() => encodeMirrorFrames({ kind: 'snapshot', tabId: 1, seq: 0, rawLength: 8 * 1024 * 1024 + 1, payload: new Uint8Array(1), deflate: true })).toThrow(/8 MiB/);
    const [buf] = encodeMirrorFrames({ kind: 'batch', tabId: 1, seq: 1, rawLength: 1, payload: new Uint8Array(1), deflate: false });
    new DataView(buf!).setUint32(16, 8 * 1024 * 1024 + 1);
    expect(decodeMirrorFrame(buf!)).toEqual({ ok: false, reason: 'too_large' });
    expect(decodeMirrorFrame(new Uint8Array(5))).toEqual({ ok: false, reason: 'short' });
    const bad = new Uint8Array(buf!.slice(0));
    bad[0] = 1;
    expect(decodeMirrorFrame(bad)).toEqual({ ok: false, reason: 'version' });
  });

  it('deflate round trip, and inflation stops past the cap', async () => {
    const raw = json(2000);
    const def = await deflatePayload(raw);
    expect(def.length).toBeLessThan(raw.length);
    const parts = encodeMirrorFrames({ kind: 'snapshot', tabId: 2, seq: 0, rawLength: raw.length, payload: def, deflate: true, chunkBytes: 256 });
    const r = new MirrorReassembler();
    let out = null;
    for (const p of parts) out = r.push(p);
    expect(isMirrorMessage(out) && out.deflate).toBe(true);
    if (isMirrorMessage(out)) expect(utf8Decode(await inflatePayload(out.payload))).toBe(utf8Decode(raw));
    await expect(inflatePayload(def, 100)).rejects.toThrow(/exceeds/);
  });
});
