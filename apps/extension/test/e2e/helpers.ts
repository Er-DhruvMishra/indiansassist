/** Helpers for the extension e2e: browser launch flags, screenshots, console capture, replayer and data-channel probes. */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Frame, Page } from '@playwright/test';

export const ARTIFACTS = resolve(dirname(fileURLToPath(import.meta.url)), 'artifacts');
export const API = `http://localhost:${process.env.E2E_API_PORT || '4000'}`;
export const WEB = 'http://localhost:5173';
export const FIXTURES = `http://localhost:${process.env.E2E_FIXTURE_PORT || '4175'}`;
export const HEADLESS = process.env.E2E_HEADED !== '1';

/** Fake media on both sides; host candidates as plain IPs so two Chromium processes on one machine connect P2P. */
export const MEDIA_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-features=WebRtcHideLocalIpsWithMdns',
];

let shotIndex = 0;
export const shots: string[] = [];

export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(ARTIFACTS, { recursive: true });
  shotIndex += 1;
  const file = resolve(ARTIFACTS, `${String(shotIndex).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  shots.push(file);
}

/** Prints page errors and console errors with a side prefix (diagnostics only, never asserted). */
export function captureConsole(page: Page, side: string): void {
  page.on('pageerror', (e) => console.log(`[${side} pageerror] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[${side} console.error] ${m.text()}`);
  });
}

/** Waits for a page of the context whose URL matches (already open or opened later). */
export async function pageMatching(
  ctx: BrowserContext,
  test: (url: string) => boolean,
  timeout = 20_000,
): Promise<Page> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const p = ctx.pages().find((x) => test(x.url()));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `no page matching within ${timeout} ms; open: ${ctx
      .pages()
      .map((p) => p.url())
      .join(', ')}`,
  );
}

/**
 * Test hook installed in the Assist context before any page script: records every RTCDataChannel the Desk
 * opens towards the console, so the test can send a raw control frame the console UI would never send.
 */
export function recordDataChannels(): void {
  const w = window as unknown as { __iaDcs: RTCDataChannel[]; RTCPeerConnection: typeof RTCPeerConnection };
  w.__iaDcs = [];
  const Orig = w.RTCPeerConnection;
  if (!Orig) return;
  class Recording extends Orig {
    constructor(cfg?: RTCConfiguration) {
      super(cfg);
      this.addEventListener('datachannel', (e) => w.__iaDcs.push(e.channel));
    }
  }
  w.RTCPeerConnection = Recording;
}

export type MirroredDoc = {
  text: string;
  password: string | null;
  name: string | null;
  sensitive: string | null;
  blocked: boolean;
};

/** Reads the document rrweb rebuilt inside the console's replayer frame (the visible replayer only). */
export async function readMirror(page: Page): Promise<MirroredDoc | null> {
  const frame: Frame | undefined = page.frames().find((f) => f.url().includes('/replayer.html'));
  if (!frame) return null;
  return frame.evaluate(() => {
    const iframes = [...document.querySelectorAll('iframe')].filter(
      (f) => (f.closest('[style*="display: none"]') ?? null) === null,
    );
    const doc = (iframes[0] ?? document.querySelector('iframe'))?.contentDocument;
    if (!doc?.body) return null;
    const pw = doc.querySelector('#pw') as HTMLInputElement | null;
    const name = doc.querySelector('#name') as HTMLInputElement | null;
    return {
      text: doc.body.innerText ?? doc.body.textContent ?? '',
      password: pw ? pw.value || pw.getAttribute('value') : null,
      name: name ? name.value || name.getAttribute('value') : null,
      sensitive: doc.querySelector('#sensitive')?.textContent ?? null,
      blocked: (doc.body.textContent ?? '').includes('BLOCKED-PANEL-CONTENT'),
    };
  });
}

/** Sends one raw `ctl.req` on the Assist's `ia.control` channel and resolves with the matching `ctl.res`. */
export async function rawControl(
  page: Page,
  req: Record<string, unknown>,
): Promise<{ transport: string; res: unknown }> {
  return page.evaluate(async (r) => {
    const dcs = (window as unknown as { __iaDcs?: RTCDataChannel[] }).__iaDcs ?? [];
    const dc = [...dcs].reverse().find((d) => d.label === 'ia.control' && d.readyState === 'open');
    if (!dc) return { transport: 'none', res: null };
    return new Promise<{ transport: string; res: unknown }>((resolveRes) => {
      const timer = setTimeout(() => resolveRes({ transport: 'dc', res: 'timeout' }), 10_000);
      dc.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string') return;
        try {
          const m = JSON.parse(ev.data) as { t?: string; id?: string };
          if (m.t === 'ctl.res' && m.id === r.id) {
            clearTimeout(timer);
            resolveRes({ transport: 'dc', res: m });
          }
        } catch {
          /* not JSON */
        }
      });
      dc.send(JSON.stringify(r));
    });
  }, req);
}
