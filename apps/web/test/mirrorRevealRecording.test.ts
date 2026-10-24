/**
 * Phase B 4.7 / PRD 12.3 (SEC-P2-02, prd-F1): with `policy.recordRevealed` false a revealed value never reaches the
 * mirror recording. The Desk sends the revealing FullSnapshot before `mirror.tab { revealed }` and before the
 * `mask.request` answer, so the recorder holds lines from the request on and re-masks the tab's snapshot, mutation
 * texts / values / added nodes and drops Input events until `restored`; a refused request is written unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MASK_FIXED, base64urlEncode, utf8Encode, type ConsentLevel, type ControlRequest, type TabInfo } from '@indiansassist/shared';
import { EMPTY_PLANE, MirrorPlane, type PlaneSnap } from '../src/assist/console/mirror/mirrorPlane';
import { MirrorRecorder } from '../src/assist/console/mirror/mirrorRecorder';
import { maskNode, redact } from '../src/assist/console/mirror/mirrorRedact';
import { IDS } from './fakes';

const SECRET = 'AADHAAR 1234 5678 9012';
const NAME = 'Rahul Sharma';
const header = { sessionId: IDS.session, assist: { id: IDS.user, name: 'A' }, rrweb: '2.1.7', tabs: [] };

/** A FullSnapshot of a page with public text, a sensitive div, an input and a style element. */
function page(sensitive: string, value: string, extra = 'Welcome'): unknown[] {
  const node = {
    type: 0,
    id: 1,
    childNodes: [
      {
        type: 2,
        id: 2,
        tagName: 'html',
        attributes: {},
        childNodes: [
          { type: 2, id: 3, tagName: 'style', attributes: {}, childNodes: [{ type: 3, id: 4, textContent: '.a{color:red}', isStyle: true }] },
          { type: 2, id: 5, tagName: 'h1', attributes: {}, childNodes: [{ type: 3, id: 6, textContent: extra }] },
          { type: 2, id: 7, tagName: 'div', attributes: { 'data-ia-sensitive': '' }, childNodes: [{ type: 3, id: 8, textContent: sensitive }] },
          { type: 2, id: 9, tagName: 'input', attributes: { type: 'text', value }, childNodes: [] },
        ],
      },
    ],
  };
  return [
    { type: 4, timestamp: 1, data: { href: '', width: 1280, height: 800 } },
    { type: 2, timestamp: 2, data: { node, initialOffset: { top: 0, left: 0 } } },
  ];
}
const mutation = (text: string, value: string, added: string) => ({
  type: 3,
  timestamp: 10,
  data: {
    source: 0,
    texts: [{ id: 8, value: text }],
    attributes: [{ id: 9, attributes: { value, class: 'x' } }],
    removes: [],
    adds: [{ parentId: 7, nextId: null, node: { type: 3, id: 20, textContent: added } }],
  },
});
const input = (text: string) => ({ type: 3, timestamp: 11, data: { source: 5, id: 9, text, isChecked: false } });
const move = { type: 3, timestamp: 12, data: { source: 1, positions: [{ x: 1, y: 1, id: 1, timeOffset: 0 }] } };

describe('mirrorRedact', () => {
  it('masks snapshot text and values but keeps style text, ids and structure', () => {
    const [, full] = page(SECRET, NAME) as [unknown, { data: { node: unknown } }];
    const out = JSON.stringify(redact(full));
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(NAME);
    expect(out).not.toContain('Welcome');
    expect(out).toContain('.a{color:red}');
    expect(out).toContain(MASK_FIXED);
    expect(JSON.stringify(maskNode(full.data.node)).match(/"id":/g)).toHaveLength(9);
  });

  it('masks mutation texts, value attributes and added nodes and drops Input', () => {
    const out = redact(mutation('typed secret', 'value secret', 'added secret')) as { data: { attributes: { attributes: Record<string, unknown> }[] } };
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/typed secret|value secret|added secret/);
    expect(out.data.attributes[0]!.attributes.class).toBe('x');
    expect(redact(input('x'))).toBeNull();
    expect(redact(move)).toBe(move);
  });
});

describe('MirrorRecorder reveal window', () => {
  let t: number;
  beforeEach(() => {
    t = 1_000;
  });
  const lines = (r: MirrorRecorder) => r.text().trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

  it('holds lines while a request is open and writes them unchanged when it is refused', () => {
    const rec = new MirrorRecorder(header, false, () => t);
    rec.ask(5);
    for (const e of page('public sensitive', 'public value')) rec.event(5, 0, e);
    rec.meta({ t: 'mirror.tabs' });
    expect(rec.lineCount).toBe(1);
    rec.answered(5, false, 'tab');
    expect(rec.text()).toContain('public sensitive');
    expect(rec.text()).not.toContain('redacted');
    expect(lines(rec).map((l) => ('e' in l ? 'e' : 'meta'))).toEqual(['meta', 'e', 'e', 'meta']);
  });

  it('re-masks a snapshot received before the answer and everything up to restored (fail closed on finish)', async () => {
    const rec = new MirrorRecorder(header, false, () => t);
    rec.ask(5);
    for (const e of page(SECRET, NAME)) rec.event(5, 0, e);
    rec.revealStart(5, 'tab'); // `mirror.tab revealed` arrives after the snapshot
    rec.answered(5, true, 'tab');
    rec.event(5, 1, mutation('typed secret', 'value secret', 'added secret'));
    rec.event(5, 2, input('input secret'));
    rec.event(5, 3, move);
    t += 20_000;
    expect(rec.revealEnd(5)).toBe(true);
    for (const e of page('masked again', 'masked again', 'After')) rec.event(5, 0, e);
    const text = rec.text();
    expect(text).not.toMatch(new RegExp(`${SECRET}|${NAME}|typed secret|value secret|added secret|input secret`));
    expect(text).toContain('After');
    expect(lines(rec).find((l) => 'redacted' in l)).toEqual({ tabId: 5, redacted: { scope: 'tab', from: 1_000, to: 21_000 }, rx: 21_000 });

    const open = new MirrorRecorder(header, false, () => t);
    open.ask(6);
    for (const e of page(SECRET, NAME)) open.event(6, 0, e);
    const back = await new Response((await open.finish()).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    expect(back).not.toContain(SECRET);
    expect(back).toContain('"redacted"');
  });

  it('a restored of an earlier reveal does not settle a newer pending request', () => {
    const rec = new MirrorRecorder(header, false, () => t);
    rec.revealStart(5, 'field');
    rec.ask(5); // second request while the first reveal is live
    rec.revealEnd(5); // the first reveal times out
    for (const e of page(SECRET, NAME)) rec.event(5, 0, e); // the second grant's snapshot
    rec.answered(5, true, 'tab');
    rec.revealEnd(5);
    expect(rec.text()).not.toContain(SECRET);
    expect(lines(rec).filter((l) => 'redacted' in l)).toHaveLength(2);
  });

  it('keeps everything with recordRevealed and never holds lines', () => {
    const rec = new MirrorRecorder(header, true, () => t);
    rec.ask(5);
    for (const e of page(SECRET, NAME)) rec.event(5, 0, e);
    expect(rec.text()).toContain(SECRET);
    rec.answered(5, true, 'tab');
    expect(rec.revealEnd(5)).toBe(false);
  });
});

describe('MirrorPlane recording during a reveal', () => {
  let state: PlaneSnap & { level: ConsentLevel | null };
  let sent: ControlRequest[];
  let rec: MirrorRecorder;
  let plane: MirrorPlane;

  const info = (revealed: TabInfo['revealed']): TabInfo => ({ tabId: 5, windowId: 1, index: 0, title: 'Form', url: 'https://a.example/', favicon: null, active: true, pinned: false, muted: false, audible: false, groupId: -1, status: 'complete', mirrored: 'yes', backstage: false, createdByAssist: false, revealed, discarded: false });
  const relay = async (kind: 'snapshot' | 'batch', seq: number, events: unknown[]) => {
    plane.pushRelay({ tabId: 5, seq, kind, enc: 'none', part: 1, parts: 1, data: base64urlEncode(utf8Encode(JSON.stringify(events))) });
    await plane.receiver.drain();
  };
  const tabMsg = (state: 'revealed' | 'restored', revealed: TabInfo['revealed']) => plane.mirrorJson({ t: 'mirror.tab', tab: info(revealed), state, ts: Date.now() });

  beforeEach(() => {
    state = { ...EMPTY_PLANE, level: 'view' };
    sent = [];
    rec = new MirrorRecorder(header, false);
    plane = new MirrorPlane({
      sessionId: IDS.session,
      get: () => state,
      set: (p) => (state = { ...state, ...p }),
      sendMirror: () => undefined,
      sendDc: (m) => (sent.push(m), true),
      sendRelay: () => false,
      report: async () => undefined,
      recorder: () => rec,
    });
  });
  afterEach(() => plane.dispose());

  it('stores no revealed value: reveal snapshot first, then revealed, the answer, mutations and restored', async () => {
    await relay('snapshot', 0, page('********', '****', 'Welcome'));
    const answer = plane.requestReveal({ tabId: 5, scope: 'tab' }, 'check the address');
    await relay('snapshot', 0, page(SECRET, NAME));
    tabMsg('revealed', 'tab');
    const req = sent.find((m) => m.op === 'mask.request')!;
    plane.control.handle({ t: 'ctl.res', id: req.id, ok: true, result: { granted: true, ttlMs: 60_000 }, ts: Date.now() });
    await answer;
    await relay('batch', 1, [mutation('typed secret', 'value secret', 'added secret'), input('input secret')]);
    await relay('snapshot', 0, page('********', '****', 'Restored')); // the restore snapshot precedes `restored`
    tabMsg('restored', 'none');
    expect(sent.at(-1)).toMatchObject({ op: 'mirror.snapshot', args: { tabId: 5 } }); // re-sync the recording
    await relay('snapshot', 0, page('********', '****', 'Fresh'));
    const text = rec.text();
    expect(text).not.toMatch(new RegExp(`${SECRET}|${NAME}|typed secret|value secret|added secret|input secret`));
    expect(text).toContain('Welcome');
    expect(text).toContain('Fresh');
    expect(text).toContain('"redacted"');
  });

  it('a refused request records the following snapshot unchanged', async () => {
    const answer = plane.requestReveal({ tabId: 5, scope: 'tab' }, 'check the address');
    await relay('snapshot', 0, page('********', '****', 'Still masked'));
    const req = sent.find((m) => m.op === 'mask.request')!;
    plane.control.handle({ t: 'ctl.res', id: req.id, ok: true, result: { granted: false }, ts: Date.now() });
    await answer;
    expect(rec.text()).toContain('Still masked');
    expect(rec.text()).not.toContain('"redacted"');
  });
});
