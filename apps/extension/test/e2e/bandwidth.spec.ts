/**
 * Package 2 bandwidth gate (PRD 13 "P2 under 100 kbps typical", contract section 13.4). One session (session.ts:
 * join page, consent "This tab only / View"), three measured windows of `E2E_BW_SECONDS` (default 60, the
 * contract's window; a smaller value is for quick local runs only), each starting at t = 5 s:
 *
 *   A   form.html, voice off (gated): t = 0 is the Desk's Share click. 200 characters typed across the 4 fields
 *       (50 each), the long list scrolled end to end twice (two top -> bottom -> top round trips, the stricter
 *       reading), 10 toggle buttons clicked (one every 6 s) and the mouse moving continuously at 30 Hz.
 *   B   spa.html (informational): the shared tab navigates to the 500-row list (t = 0 is the navigation); the list
 *       is scrolled end to end (round trip) with all 500 rows, a 10-character filter ("payroll te") is typed one
 *       key at a time, each keystroke re-rendering the whole list (500 -> 100 rows), and the filtered list is
 *       scrolled again.
 *   A+V form.html with voice on (informational): the Desk unmutes in the side panel, the Assist turns voice on
 *       (fake microphones on both sides, Opus), the shared tab navigates back to form.html (t = 0) and script A runs
 *       again.
 *
 * Measured on the Assist with `pc.getStats()` at the window's start and end: (1) mirror-only = the `ia.mirror`
 * `data-channel` `bytesReceived` delta; (2) whole transport = the `transport` entry's `bytesReceived + bytesSent`
 * delta (DTLS/SCTP/RTP, all channels, both directions); for A+V the audio RTP share (`inbound-rtp` +
 * `outbound-rtp` of kind audio, payload + header bytes) is reported separately. kbps = bytes * 8 / elapsed / 1000,
 * elapsed being the measured wall time between the two `getStats()` reads (the 60 s script plus a few ms of
 * Playwright overhead). The initial snapshot on the wire is the `ia.mirror` byte count at A's t = 5 s.
 *
 * Differences from the contract's wording (Playwright limits, kept as close as possible): the three windows share
 * one session, so B and A+V start after a navigation of the shared tab rather than after a fresh Share; voice-on is
 * measured on a second run of script A rather than the same window as the voice-off figure (a window cannot be
 * both). With `E2E_BW_SECONDS` < 60, script A scales its counts with the window (200 * W / 60 characters,
 * 10 * W / 60 clicks, still two scroll round trips, so scrolling is denser), B keeps its 10 keystrokes.
 *
 * Gated: A mirror-only <= 100 kbps, A initial snapshot <= 150 KiB. Printed (and in `artifacts/bandwidth.json`, and
 * in `$GITHUB_STEP_SUMMARY` when set): every number above.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ARTIFACTS, FIXTURES, assistStats, readMirror, shots, type PcStats } from './helpers';
import { DESK_NAME, startP2Session, type P2Session } from './session';

const WINDOW_S = Number(process.env.E2E_BW_SECONDS || 60);
const START_AT_S = 5; // the window starts at t = 5 s, after the initial snapshot
const LIMIT_KBPS = 100;
const SNAPSHOT_LIMIT = 150 * 1024;
const TICK_MS = 1000 / 30; // the mouse moves at 30 Hz
const FIELDS = ['#name', '#city', '#dept', '#notes'];
const WORDS = 'the quick brown fox jumps over the lazy dog while payroll runs on time ';
const FILTER = 'payroll te';

type WindowResult = {
  seconds: number;
  /** Seconds after t = 0 at which the window started (>= 5). */
  startedAt: number;
  mirrorBytes: number;
  mirrorKbps: number;
  transportKbps: number;
  audioKbps: number;
};

const kbps = (bytes: number, seconds: number) => (bytes * 8) / seconds / 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Waits for t = 5 s, reads the stats, runs the script, reads them again. */
async function measure(assist: Page, t0: number, script: () => Promise<void>): Promise<WindowResult & { start: PcStats }> {
  await sleep(t0 + START_AT_S * 1000 - Date.now());
  const start = await assistStats(assist);
  const ts = Date.now();
  await script();
  const end = await assistStats(assist);
  const seconds = (Date.now() - ts) / 1000;
  const mirrorBytes = (end.channelBytes['ia.mirror'] ?? 0) - (start.channelBytes['ia.mirror'] ?? 0);
  return {
    start,
    seconds,
    startedAt: (ts - t0) / 1000,
    mirrorBytes,
    mirrorKbps: kbps(mirrorBytes, seconds),
    transportKbps: kbps(end.transportBytes - start.transportBytes, seconds),
    audioKbps: kbps(end.audioRtpBytes - start.audioRtpBytes, seconds),
  };
}

/** Runs `step(t, u)` at 30 Hz for `seconds` (t in seconds, u = t / seconds in [0, 1)). */
async function ticks(page: Page, seconds: number, step: (t: number, u: number) => Promise<void>): Promise<void> {
  const t0 = Date.now();
  for (let tick = 1; Date.now() - t0 < seconds * 1000; tick++) {
    const t = (Date.now() - t0) / 1000;
    await step(t, t / seconds);
    await page.waitForTimeout(Math.max(0, t0 + tick * TICK_MS - Date.now()));
  }
}

/** Scroll position (0..1) of two top -> bottom -> top round trips inside [a, b) and [c, d) of the window. */
function roundTrip(u: number, spans: [number, number][]): number | null {
  for (const [a, b] of spans) {
    if (u >= a && u < b) {
      const p = (u - a) / (b - a);
      return p < 0.5 ? p * 2 : 2 - p * 2;
    }
  }
  return null;
}

async function scrollTo(page: Page, selector: string, pos: number): Promise<void> {
  await page.locator(selector).evaluate((el, p) => {
    el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * p);
  }, pos);
}

/** Scenario A (contract 13.4) on form.html. Returns what was done, for the assertions. */
async function scenarioA(page: Page, seconds: number): Promise<{ typed: number; clicked: number; scrolled: number }> {
  const chars = Math.round((200 * seconds) / 60);
  const perField = Math.ceil(chars / FIELDS.length);
  const clicks = Math.max(1, Math.round((10 * seconds) / 60));
  let typed = 0;
  let clicked = 0;
  let scrolled = 0;
  let focused = -1;
  await ticks(page, seconds, async (t, u) => {
    await page.mouse.move(640 + 420 * Math.cos(t * 2.1), 470 + 260 * Math.sin(t * 2.9));
    while (typed < Math.min(chars, Math.ceil(u * chars))) {
      const field = Math.floor(typed / perField);
      if (field !== focused) {
        await page.locator(FIELDS[field]!).focus();
        focused = field;
      }
      await page.keyboard.type(WORDS[typed % WORDS.length]!);
      typed += 1;
    }
    if (clicked < clicks && u >= (clicked + 0.5) / clicks) {
      await page.locator(`#flip-${clicked % 10}`).click();
      clicked += 1;
      focused = -1; // the click took the focus; the next character refocuses the field
    }
    const pos = roundTrip(u, [
      [0.1, 0.35],
      [0.6, 0.85],
    ]);
    if (pos !== null) {
      await scrollTo(page, '#list', pos);
      scrolled += 1;
    }
  });
  // The last keystrokes of a 30 Hz loop that ended a tick early.
  while (typed < chars) {
    await page.keyboard.type(WORDS[typed % WORDS.length]!);
    typed += 1;
  }
  return { typed, clicked, scrolled };
}

/** Scenario B (contract 13.4) on spa.html. */
async function scenarioB(page: Page, seconds: number): Promise<{ typed: number }> {
  let typed = 0;
  await page.locator('#filter').focus();
  await ticks(page, seconds, async (_t, u) => {
    const pos = roundTrip(u, [
      [0.05, 0.3],
      [0.7, 0.95],
    ]);
    if (pos !== null) await scrollTo(page, '#rows', pos);
    // The 10 keystrokes are spread over [0.35, 0.65) of the window.
    while (typed < FILTER.length && u >= 0.35 + (0.3 * typed) / FILTER.length) {
      await page.keyboard.type(FILTER[typed]!);
      typed += 1;
    }
  });
  return { typed };
}

function report(lines: string[], data: Record<string, unknown>): void {
  const text = lines.join('\n');
  console.log(text);
  test.info().annotations.push({ type: 'bandwidth', description: text });
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(resolve(ARTIFACTS, 'bandwidth.json'), `${JSON.stringify(data, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### P2 bandwidth (contract 13.4)\n\n\`\`\`\n${text}\n\`\`\`\n`);
}

test('Package 2: mirror bandwidth (contract 13.4: scenario A gated, scenario B and voice-on totals printed)', async () => {
  test.setTimeout(150_000 + 3 * (WINDOW_S + 25) * 1000);
  let s: P2Session | null = null;
  const results: Record<string, unknown> = { windowSeconds: WINDOW_S, startAtSeconds: START_AT_S };
  const lines = [`bandwidth (contract 13.4; window ${WINDOW_S} s from t = ${START_AT_S} s; Assist pc.getStats()):`];
  let a: WindowResult | null = null;
  let snapshotBytes = 0;
  try {
    s = await startP2Session({ org: 'E2E Bandwidth Clinic', label: 'E2E bandwidth ticket', consent: { level: 'view' } });
    const { assist, fixture, panel, sharedAt } = s;
    await fixture.bringToFront(); // the shared tab is the focused one (unfocused tabs are buffered, section 4.3)
    await expect.poll(async () => (await readMirror(assist))?.text ?? '', { timeout: 30_000 }).toContain('Payroll row 200');
    for (const f of FIELDS) await fixture.locator(f).fill(''); // the session setup typed into #name
    await fixture.mouse.move(640, 470);

    await test.step(`Scenario A (form.html, voice off): ${WINDOW_S} s of typing, scrolling, clicking and mouse moves`, async () => {
      let done = { typed: 0, clicked: 0, scrolled: 0 };
      const r = await measure(assist, sharedAt, async () => {
        done = await scenarioA(fixture, WINDOW_S);
      });
      a = r;
      snapshotBytes = r.start.channelBytes['ia.mirror'] ?? 0;
      results.scenarioA = { ...done, ...r, start: undefined, snapshotBytes };
      lines.push(
        `  A   form.html initial snapshot on the wire: ${(snapshotBytes / 1024).toFixed(1)} KiB (limit 150 KiB)`,
        `  A   form.html mirror-only: ${r.mirrorKbps.toFixed(1)} kbps (limit ${LIMIT_KBPS}; ${r.mirrorBytes} B over ${r.seconds.toFixed(1)} s from t = ${r.startedAt.toFixed(1)} s)`,
        `  A   form.html whole transport, voice off: ${r.transportKbps.toFixed(1)} kbps`,
      );
      console.log(lines.slice(-3).join('\n'));
      expect(done.typed).toBe(Math.round((200 * WINDOW_S) / 60));
      expect(done.clicked).toBe(Math.max(1, Math.round((10 * WINDOW_S) / 60)));
      expect(done.scrolled).toBeGreaterThan(10);
      // The window really went over the data channel (a relayed or stalled mirror would leave it idle).
      expect(r.mirrorBytes, 'mirror traffic during the window').toBeGreaterThan(2000);
      await expect
        .poll(async () => (await readMirror(assist))?.text ?? '')
        .toContain((await fixture.locator('#flip-0').textContent()) ?? 'Flip 0');
    });

    await test.step(`Scenario B (spa.html): scroll, a 10-character filter re-rendering 500 rows, scroll; ${WINDOW_S} s`, async () => {
      const before = (await assistStats(assist)).channelBytes['ia.mirror'] ?? 0;
      const t0 = Date.now();
      await fixture.goto(`${FIXTURES}/spa.html`);
      await expect.poll(async () => (await readMirror(assist))?.text ?? '', { timeout: 30_000 }).toContain('500 of 500 employees');
      let typed = 0;
      const r = await measure(assist, t0, async () => {
        typed = (await scenarioB(fixture, WINDOW_S)).typed;
      });
      const spaSnapshot = (r.start.channelBytes['ia.mirror'] ?? 0) - before;
      results.scenarioB = { typed, ...r, start: undefined, snapshotBytes: spaSnapshot };
      lines.push(
        `  B   spa.html snapshot after navigation: ${(spaSnapshot / 1024).toFixed(1)} KiB (informational)`,
        `  B   spa.html mirror-only: ${r.mirrorKbps.toFixed(1)} kbps (informational; ${r.mirrorBytes} B over ${r.seconds.toFixed(1)} s)`,
        `  B   spa.html whole transport, voice off: ${r.transportKbps.toFixed(1)} kbps (informational)`,
      );
      console.log(lines.slice(-3).join('\n'));
      expect(typed).toBe(FILTER.length);
      await expect(fixture.locator('#count')).toHaveText('100 of 500 employees');
      await expect.poll(async () => (await readMirror(assist))?.text ?? '').toContain('100 of 500 employees');
    });

    await test.step(`Scenario A with voice on (Opus, fake microphones): ${WINDOW_S} s`, async () => {
      const voice = assist.getByRole('region', { name: 'Voice' });
      await panel.bringToFront();
      await panel.getByRole('button', { name: 'Unmute', exact: true }).click();
      await expect(panel.getByText('Your technician can hear you')).toBeVisible();
      await expect(voice).toContainText(`${DESK_NAME}'s microphone is on`);
      await voice.getByRole('button', { name: 'Turn voice on' }).click();
      await expect(voice.getByRole('button', { name: 'Turn voice off' })).toBeVisible();
      await expect
        .poll(async () => (await assistStats(assist)).audioIn.bytes, { message: 'Assist receives the Desk microphone', timeout: 20_000 })
        .toBeGreaterThan(0);
      await fixture.bringToFront();
      const t0 = Date.now();
      await fixture.goto(`${FIXTURES}/form.html`);
      await expect.poll(async () => (await readMirror(assist))?.text ?? '', { timeout: 30_000 }).toContain('Payroll row 200');
      await fixture.mouse.move(640, 470);
      let done = { typed: 0, clicked: 0, scrolled: 0 };
      const r = await measure(assist, t0, async () => {
        done = await scenarioA(fixture, WINDOW_S);
      });
      results.scenarioAVoice = { ...done, ...r, start: undefined };
      const other = r.transportKbps - r.mirrorKbps - r.audioKbps;
      lines.push(
        `  A+V form.html whole transport, voice on: ${r.transportKbps.toFixed(1)} kbps (informational) = ` +
          `mirror ${r.mirrorKbps.toFixed(1)} + voice RTP ${r.audioKbps.toFixed(1)} + other ${other.toFixed(1)} (DTLS/SCTP/RTCP overhead, ia.ctrl, ia.control)`,
      );
      console.log(lines.slice(-1).join('\n'));
      expect(r.audioKbps, 'voice flowed during the window').toBeGreaterThan(1);
      expect(r.mirrorBytes, 'mirror traffic during the window').toBeGreaterThan(2000);
    });

    await panel.getByRole('button', { name: 'Stop sharing' }).click();
    await expect(panel.getByRole('heading', { name: 'Session ended' })).toBeVisible();
  } finally {
    report(lines, results);
    console.log(`screenshots:\n${shots.join('\n')}`);
    await s?.close();
  }
  // The gate (contract 13.4), after every number was printed.
  const gated = a as WindowResult | null;
  expect(gated, 'scenario A measured').not.toBeNull();
  expect(snapshotBytes, 'initial snapshot of form.html on the wire').toBeLessThanOrEqual(SNAPSHOT_LIMIT);
  expect(gated!.mirrorKbps, `scenario A mirror-only average <= ${LIMIT_KBPS} kbps`).toBeLessThanOrEqual(LIMIT_KBPS);
});
