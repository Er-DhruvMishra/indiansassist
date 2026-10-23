import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  EXECUTABLE_EXTENSIONS,
  REGION_LABELS,
  TIER_ORDER,
  auditDataSchema,
  dataChannelMessageSchema,
  decodeFileChunk,
  deskActorLabel,
  encodeFileChunk,
  fileExtension,
  isExecutableName,
  isRegion,
  isRegionServed,
  parseDataChannelMessage,
  parseRegionList,
  parseRegionOrigins,
  roundCoord,
  sanitiseFileName,
  sanitiseReason,
  sanitiseText,
  DEFAULT_REGION,
} from '../src/index.js';

const ID = '11111111-2222-4333-8444-555555555555';
const H = 'c'.repeat(64);

const DC_EXAMPLES = [
  { t: 'chat', msgId: ID, from: 'assist', text: 'hello', ts: 1 },
  { t: 'chat.ack', msgId: ID, ts: 1 },
  { t: 'typing', from: 'desk', active: true, ts: 1 },
  {
    t: 'annot',
    id: ID,
    shape: 'arrow',
    a: { x: 0.1, y: 0.2 },
    b: { x: 0.3, y: 0.4 },
    color: '#f59e0b',
    ttlMs: 8000,
    ts: 1,
  },
  { t: 'annot', id: ID, shape: 'rect', a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, color: '#ff0000', ttlMs: 60000, ts: 1 },
  {
    t: 'annot',
    id: ID,
    shape: 'highlight',
    a: { x: 0.5, y: 0.5 },
    b: { x: 0.6, y: 0.6 },
    color: '#00ff00',
    ttlMs: 100,
    ts: 1,
  },
  { t: 'annot', id: ID, shape: 'pointer', at: { x: 0.5, y: 0.5 }, color: '#f59e0b', ts: 1 },
  { t: 'annot', shape: 'clear', ts: 1 },
  {
    t: 'file.offer',
    fileId: 1,
    name: 'report.pdf',
    size: 40000,
    mime: 'application/pdf',
    sha256: H,
    chunkSize: 16384,
    chunks: 3,
    ts: 1,
  },
  { t: 'file.accept', fileId: 1, ts: 1 },
  { t: 'file.reject', fileId: 1, reason: 'too_large', ts: 1 },
  { t: 'file.done', fileId: 1, ts: 1 },
  { t: 'file.ack', fileId: 1, ok: true, sha256: H, ts: 1 },
  { t: 'file.cancel', fileId: 1, reason: 'bad_chunk', ts: 1 },
  { t: 'file.cancel', fileId: 1, ts: 1 },
  { t: 'stop.sharing', ts: 1 },
  { t: 'consent.revoked', ts: 1 },
  { t: 'recording.state', recording: true, ts: 1 },
  { t: 'voice.state', from: 'desk', muted: false, ts: 1 },
  { t: 'ping', ts: 1 },
  { t: 'pong', ts: 1 },
];

describe('data channel schemas', () => {
  it.each(DC_EXAMPLES)('accepts $t', (example) => {
    expect(dataChannelMessageSchema.safeParse(example).success).toBe(true);
  });

  it('applies annotation defaults and limits', () => {
    const arrow = dataChannelMessageSchema.parse({
      t: 'annot',
      id: ID,
      shape: 'arrow',
      a: { x: 0, y: 0 },
      b: { x: 1, y: 1 },
      ts: 1,
    });
    expect(arrow).toMatchObject({ color: '#f59e0b', ttlMs: 8000 });
    expect(
      dataChannelMessageSchema.safeParse({
        t: 'annot',
        id: ID,
        shape: 'arrow',
        a: { x: 1.2, y: 0 },
        b: { x: 1, y: 1 },
        ts: 1,
      }).success,
    ).toBe(false);
    expect(
      dataChannelMessageSchema.safeParse({
        t: 'annot',
        id: ID,
        shape: 'rect',
        a: { x: 0, y: 0 },
        b: { x: 1, y: 1 },
        ttlMs: 60001,
        ts: 1,
      }).success,
    ).toBe(false);
    expect(roundCoord(0.123456)).toBe(0.1235);
    expect(roundCoord(2)).toBe(1);
  });

  it('checks file offer chunk count and channel membership', () => {
    expect(dataChannelMessageSchema.safeParse({ ...DC_EXAMPLES[8], chunks: 2 }).success).toBe(false);
    expect(parseDataChannelMessage('ia.chat', JSON.stringify(DC_EXAMPLES[0]), 'assist').ok).toBe(true);
    expect(parseDataChannelMessage('ia.chat', JSON.stringify(DC_EXAMPLES[0]), 'desk')).toMatchObject({
      ok: false,
      reason: 'bad_payload',
    });
    expect(parseDataChannelMessage('ia.ctrl', JSON.stringify(DC_EXAMPLES[0]))).toMatchObject({
      ok: false,
      reason: 'wrong_channel',
    });
    expect(parseDataChannelMessage('ia.file', '{nope')).toMatchObject({ ok: false, reason: 'bad_json' });
  });

  it('round trips binary chunks', () => {
    const payload = Uint8Array.from([1, 2, 3]);
    const frame = encodeFileChunk(0xdeadbeef, 7, payload);
    expect(Array.from(frame.slice(0, 8))).toEqual([0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 7]);
    expect(decodeFileChunk(frame.buffer as ArrayBuffer)).toEqual({ fileId: 0xdeadbeef, chunkIndex: 7, payload });
    expect(decodeFileChunk(new Uint8Array(4))).toBeNull();
    expect(() => encodeFileChunk(1, 0, new Uint8Array(16385))).toThrow();
  });
});

describe('file names', () => {
  it('sanitises per F5', () => {
    expect(sanitiseFileName('a/b\\c:d*e?f"g<h>i|j.txt', 1)).toBe('a_b_c_d_e_f_g_h_i_j.txt');
    expect(sanitiseFileName('..  .hidden', 1)).toBe('hidden');
    expect(sanitiseFileName('a   b \u00A0 c.txt', 1)).toBe('a b c.txt');
    // Tabs are C0 controls: removed before whitespace collapsing (F5 order).
    expect(sanitiseFileName('a\tb.txt', 1)).toBe('ab.txt');
    expect(sanitiseFileName('evil\u202Etxt.exe', 1)).toBe('eviltxt.exe');
    expect(sanitiseFileName('CON.txt', 1)).toBe('_CON.txt');
    expect(sanitiseFileName('lpt9', 1)).toBe('_lpt9');
    expect(sanitiseFileName('\u0000\u0001', 42)).toBe('file-42');
    const long = `${'x'.repeat(300)}.docx`;
    const out = sanitiseFileName(long, 1);
    expect(out).toHaveLength(200);
    expect(out.endsWith('.docx')).toBe(true);
    expect(sanitiseFileName('e\u0301.txt', 1)).toBe('\u00E9.txt');
  });

  it('flags executable extensions', () => {
    expect(EXECUTABLE_EXTENSIONS).toContain('ps1');
    expect(isExecutableName('setup.EXE')).toBe(true);
    expect(isExecutableName('notes.txt')).toBe(false);
    expect(fileExtension('README')).toBeNull();
    expect(fileExtension('.bashrc')).toBeNull();
  });
});

describe('audit data schemas', () => {
  it('lists every Phase A action and validates shapes', () => {
    expect(AUDIT_ACTIONS).toContain('session.ended');
    expect(auditDataSchema('auth.signup').parse({ emailHash: H })).toEqual({ emailHash: H });
    expect(() => auditDataSchema('auth.signup').parse({ email: 'a@b.co' })).toThrow();
    expect(() => auditDataSchema('auth.signup').parse({ emailHash: H, extra: 1 })).toThrow();
    expect(
      auditDataSchema('session.ended').parse({ endReason: 'denied', durationMs: null, path: 'unknown' }).durationMs,
    ).toBeNull();
    expect(
      auditDataSchema('file.sent').parse({ fileId: 1, direction: 'desk_to_assist', nameHash: H, bytes: 3, sha256: H })
        .bytes,
    ).toBe(3);
    expect(() => auditDataSchema('elevation.requested').parse({})).toThrow();
    expect(() => auditDataSchema('nope' as never)).toThrow();
  });

  it('sanitises strings before hashing', () => {
    const out = auditDataSchema('recording.failed').parse({
      recordingId: ID,
      error: `bad\u0000\u200B${'e'.repeat(600)}`,
    });
    expect(out.error).toHaveLength(500);
    expect(out.error.startsWith('bade')).toBe(true);
    expect(sanitiseReason(null)).toBeNull();
    expect(sanitiseReason('r'.repeat(600))).toHaveLength(500);
    expect(sanitiseText('\ud800x')).toBe('x');
    expect(sanitiseText('\uD83D\uDE00'.repeat(5), 3)).toBe('\uD83D\uDE00\uD83D\uDE00\uD83D\uDE00');
    expect(deskActorLabel(ID)).toBe('desk:11111111');
  });
});

describe('regions and tiers', () => {
  it('exports codes, default and labels', () => {
    expect(DEFAULT_REGION).toBe('in-mum');
    expect(REGION_LABELS['eu-fra']).toBe('EU (Frankfurt)');
    expect(isRegion('us-east')).toBe(true);
    expect(isRegion('mars')).toBe(false);
    expect(parseRegionList(' in-mum , eu-fra,in-mum')).toEqual(['in-mum', 'eu-fra']);
    expect(parseRegionList('')).toEqual([]);
    expect(() => parseRegionList('mars')).toThrow();
    expect(isRegionServed('eu-fra', [])).toBe(true);
    expect(isRegionServed('eu-fra', ['in-mum'])).toBe(false);
    expect(parseRegionOrigins('in-mum=http://localhost:5173/,eu-fra=https://eu.example')).toEqual({
      'in-mum': 'http://localhost:5173',
      'eu-fra': 'https://eu.example',
    });
    expect(TIER_ORDER.p4_installed).toBe(3);
  });
});
