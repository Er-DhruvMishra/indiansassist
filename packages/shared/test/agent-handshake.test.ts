/** Phase C section 1.3: the TS handshake driver end to end (both sides in-process) and its failure rules. */
import { describe, expect, it } from 'vitest';
import { SecHandshake, sasMatches, type SecMessage } from '../src/index.js';

const SID = '6f1c3a2e-8b7d-4c5e-9f10-a1b2c3d4e5f6';
const FD = 'd'.repeat(64);
const FA = 'a'.repeat(64);

function pair(opts: { deskRemote?: string; gen?: number } = {}) {
  const queueToAssist: SecMessage[] = [];
  const queueToDesk: SecMessage[] = [];
  const desk = new SecHandshake({ side: 'desk', sessionId: SID, gen: opts.gen ?? 0, ownFpr: FD, remoteFpr: opts.deskRemote ?? FA, send: (m) => queueToAssist.push(m), timer: false });
  const assist = new SecHandshake({ side: 'assist', sessionId: SID, gen: opts.gen ?? 0, ownFpr: FA, remoteFpr: FD, send: (m) => queueToDesk.push(m), timer: false });
  const pump = () => {
    for (let i = 0; i < 20 && (queueToAssist.length || queueToDesk.length); i++) {
      while (queueToAssist.length) assist.receive(JSON.stringify(queueToAssist.shift()));
      while (queueToDesk.length) desk.receive(JSON.stringify(queueToDesk.shift()));
    }
  };
  return { desk, assist, pump, queueToAssist, queueToDesk };
}

describe('SecHandshake', () => {
  it('both sides reach established with the same SAS and keys; frames round-trip', () => {
    const { desk, assist, pump } = pair({ gen: 2 });
    desk.start();
    assist.start();
    pump();
    expect(desk.state).toBe('established');
    expect(assist.state).toBe('established');
    expect(desk.result!.sas).toBe(assist.result!.sas);
    expect(desk.result!.sas).toMatch(/^\d{6}$/);
    const frame = assist.channel('ia.control').seal('{"t":"ctl.req"}');
    expect(desk.channel('ia.control').open(frame).text).toBe('{"t":"ctl.req"}');
    const back = desk.channel('ia.playbook').seal(new Uint8Array([1, 2, 3]));
    expect([...assist.channel('ia.playbook').open(back).bytes]).toEqual([1, 2, 3]);
  });

  it('a wrong observed fingerprint fails with fingerprint on the detecting side', () => {
    const { desk, assist, pump } = pair({ deskRemote: 'e'.repeat(64) });
    const reasons: string[] = [];
    desk.onFailed = (r) => reasons.push(`desk:${r}`);
    assist.onFailed = (r) => reasons.push(`assist:${r}`);
    desk.start();
    assist.start();
    pump();
    expect(desk.state).toBe('failed');
    expect(desk.failReason).toBe('fingerprint');
    expect(assist.state).toBe('failed');
    expect(reasons).toContain('assist:fingerprint');
  });

  it('a hello before the commit, a second commit or a wrong gen is commit; an unknown suite is suite', () => {
    const a = pair();
    a.desk.start();
    a.assist.receive({ t: 'sec.hello', v: 1, sessionId: SID, side: 'desk', suite: 'x25519-xchacha20poly1305-hkdfsha256', epk: 'A'.repeat(43), fpr: FD, ts: 1 });
    expect(a.assist.failReason).toBe('commit');

    const b = pair();
    b.assist.start();
    b.assist.receive({ t: 'sec.commit', v: 1, sessionId: SID, side: 'desk', h: 'A'.repeat(43), gen: 1, ts: 1 });
    expect(b.assist.failReason).toBe('commit');

    const c = pair();
    c.assist.start();
    c.assist.receive({ t: 'sec.commit', v: 1, sessionId: SID, side: 'desk', h: 'A'.repeat(43), gen: 0, ts: 1 });
    c.assist.receive({ t: 'sec.hello', v: 1, sessionId: SID, side: 'desk', suite: 'other', epk: 'A'.repeat(43), fpr: FD, ts: 1 });
    expect(c.assist.failReason).toBe('suite');

    const d = pair();
    d.assist.start();
    d.assist.receive({ t: 'sec.hello', v: 2, sessionId: SID, side: 'desk', suite: 'x', epk: 'A'.repeat(43), fpr: FD, ts: 1 });
    expect(d.assist.failReason).toBe('suite');
  });

  it('a hello that does not match its commit is commit; a received sec.fail ends it', () => {
    const { desk, assist, queueToAssist } = pair();
    desk.start();
    assist.start();
    const commit = queueToAssist.shift()!;
    assist.receive(commit);
    assist.receive({ t: 'sec.hello', v: 1, sessionId: SID, side: 'desk', suite: 'x25519-xchacha20poly1305-hkdfsha256', epk: 'B'.repeat(43), fpr: FD, ts: 1 });
    expect(assist.failReason).toBe('commit');
    desk.receive({ t: 'sec.fail', reason: 'nonsense', ts: 1 });
    expect(desk.failReason).toBe('commit');
  });

  it('sasMatches compares six digits ignoring spaces', () => {
    expect(sasMatches('483 920', '483920')).toBe(true);
    expect(sasMatches('483921', '483920')).toBe(false);
    expect(sasMatches('48392', '483920')).toBe(false);
  });
});
