/**
 * Package 2 bandwidth gate (PRD 13 "P2 under 100 kbps typical", contract 13.4 Scenario A, shortened): after the
 * join-page handshake and consent (session.ts) the Desk works on form.html for a fixed window (default 20 s,
 * `E2E_BW_SECONDS`): about ten characters a second across four fields, the long list scrolled end to end and
 * back, a toggle button every two seconds and the mouse moving at 30 Hz. The Assist's `pc.getStats()` gives the
 * `ia.mirror` data-channel `bytesReceived` before and after the window; the average must stay <= 100 kbps and the
 * initial snapshot <= 150 KiB on the wire. Mirror kbps, snapshot size and the whole transport's kbps are printed.
 * Scenario B (spa.html, informational) is not run: it would add a second session and a minute to the suite.
 */
import { expect, test } from '@playwright/test';
import { assistStats, readMirror, shots } from './helpers';
import { startP2Session, type P2Session } from './session';

const WINDOW_S = Number(process.env.E2E_BW_SECONDS || 20);
const LIMIT_KBPS = 100;
const SNAPSHOT_LIMIT = 150 * 1024;
const FIELDS = ['#name', '#city', '#dept', '#notes'];
const WORDS = 'the quick brown fox jumps over the lazy dog while payroll runs on time ';

test('Package 2: mirror bandwidth stays under 100 kbps on the form fixture', async () => {
  let s: P2Session | null = null;
  try {
    s = await startP2Session({ org: 'E2E Bandwidth Clinic', label: 'E2E bandwidth ticket', consent: { level: 'view' } });
    const { assist, fixture } = s;
    await expect.poll(async () => (await readMirror(assist))?.text ?? '', { timeout: 30_000 }).toContain('Payroll row 200');
    await fixture.bringToFront();
    await fixture.waitForTimeout(2000); // the snapshot and the focus change settle

    const start = await assistStats(assist);
    const snapshotBytes = start.channelBytes['ia.mirror'] ?? 0;
    let elapsed = 0;
    await test.step(`Desk types, scrolls, clicks and moves the mouse for ${WINDOW_S} s`, async () => {
      for (const f of FIELDS) await fixture.locator(f).fill('');
      const t0 = Date.now();
      let tick = 0;
      let typed = 0;
      while (Date.now() - t0 < WINDOW_S * 1000) {
        const t = (Date.now() - t0) / 1000;
        await fixture.mouse.move(300 + 250 * Math.cos(t * 2), 350 + 200 * Math.sin(t * 3));
        if (tick % 3 === 0) {
          if (typed % 50 === 0) await fixture.locator(FIELDS[(typed / 50) % FIELDS.length]!).focus();
          await fixture.keyboard.type(WORDS[typed % WORDS.length]!);
          typed += 1;
        }
        if (tick % 10 === 5) {
          const phase = (t % 10) / 10; // end to end and back every 10 s
          await fixture.locator('#list').evaluate((el, p) => {
            const max = el.scrollHeight - el.clientHeight;
            el.scrollTop = Math.round(max * (p < 0.5 ? p * 2 : 2 - p * 2));
          }, phase);
        }
        if (tick % 60 === 30) await fixture.locator(`#flip-${(tick / 60) % 10 | 0}`).click();
        tick += 1;
        await fixture.waitForTimeout(Math.max(0, t0 + tick * 33 - Date.now()));
      }
      elapsed = (Date.now() - t0) / 1000;
      expect(typed).toBeGreaterThan(WINDOW_S * 5);
    });
    const end = await assistStats(assist);

    const mirrorBytes = (end.channelBytes['ia.mirror'] ?? 0) - snapshotBytes;
    const mirrorKbps = (mirrorBytes * 8) / elapsed / 1000;
    const transportKbps = ((end.transportBytes - start.transportBytes) * 8) / elapsed / 1000;
    const summary =
      `bandwidth: initial snapshot ${(snapshotBytes / 1024).toFixed(1)} KiB; mirror ${mirrorKbps.toFixed(1)} kbps ` +
      `(${mirrorBytes} B over ${elapsed.toFixed(1)} s); whole transport ${transportKbps.toFixed(1)} kbps (voice off)`;
    console.log(summary);
    test.info().annotations.push({ type: 'bandwidth', description: summary });

    // The window really was mirrored (a relayed or stalled mirror would leave the data channel idle).
    expect(mirrorBytes, 'mirror traffic during the window').toBeGreaterThan(2000);
    await expect
      .poll(async () => (await readMirror(assist))?.text ?? '')
      .toContain((await fixture.locator('#flip-0').textContent()) ?? 'Flip 0');
    expect(snapshotBytes, 'initial snapshot on the wire').toBeLessThanOrEqual(SNAPSHOT_LIMIT);
    expect(mirrorKbps, `mirror-only average <= ${LIMIT_KBPS} kbps`).toBeLessThanOrEqual(LIMIT_KBPS);
  } finally {
    console.log(`screenshots:\n${shots.join('\n')}`);
    await s?.close();
  }
});
