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

/**
 * The sharing bar's host. Its closed shadow root is opaque to Playwright; the e2e build (IA_E2E=1) mirrors the
 * bar into host attributes (src/content/indicator.ts `mirrorBarForE2e`): `data-ia-e2e-bar` (status text),
 * `data-ia-e2e-text` (everything on the bar), `data-ia-e2e-prompts`, `data-ia-e2e-toast`, `data-ia-e2e-buttons`.
 */
export const BAR = 'ia-indicator';

/**
 * Clicks a button of the sharing bar with real mouse input at the centre the e2e hook reports, so the click
 * lands inside the closed shadow root exactly as a user's would.
 */
export async function clickBarButton(page: Page, label: string): Promise<void> {
  const raw = await page.locator(BAR).getAttribute('data-ia-e2e-buttons');
  const b = (JSON.parse(raw ?? '[]') as { label: string; x: number; y: number }[]).find((x) => x.label === label);
  if (!b) throw new Error(`no bar button "${label}" in ${raw}`);
  await page.mouse.click(b.x, b.y);
}

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
 * Test hook installed in the Assist context before any page script: records every RTCPeerConnection the console
 * creates (`__iaPcs`, for `getStats()`) and every RTCDataChannel the Desk opens towards it (`__iaDcs`), so the test
 * can measure the mirror channel and send a raw control frame the console UI would never send.
 */
export function recordDataChannels(): void {
  const w = window as unknown as {
    __iaDcs: RTCDataChannel[];
    __iaPcs: RTCPeerConnection[];
    RTCPeerConnection: typeof RTCPeerConnection;
  };
  w.__iaDcs = [];
  w.__iaPcs = [];
  const Orig = w.RTCPeerConnection;
  if (!Orig) return;
  class Recording extends Orig {
    constructor(cfg?: RTCConfiguration) {
      super(cfg);
      w.__iaPcs.push(this);
      this.addEventListener('datachannel', (e) => w.__iaDcs.push(e.channel));
    }
  }
  w.RTCPeerConnection = Recording;
}

export type PcStats = {
  /** `bytesReceived` of the `data-channel` stats entry per label, summed over open connections. */
  channelBytes: Record<string, number>;
  /** `transport` bytes received + sent. */
  transportBytes: number;
  /** Inbound audio: track live and receiving, RTP bytes. */
  audioIn: { live: boolean; unmuted: boolean; bytes: number };
  /** RTCP receiver reports about our outbound audio (the remote side receives it). */
  audioOutReports: number;
  /** Audio RTP both ways, payload + RTP headers (`inbound-rtp` + `outbound-rtp`, kind audio): the voice share. */
  audioRtpBytes: number;
};

/** Reads `getStats()` of every open peer connection the Assist page recorded. */
export async function assistStats(page: Page): Promise<PcStats> {
  return page.evaluate(async () => {
    type S = {
      type: string;
      kind?: string;
      label?: string;
      bytesReceived?: number;
      bytesSent?: number;
      roundTripTimeMeasurements?: number;
      roundTripTime?: number;
      headerBytesReceived?: number;
      headerBytesSent?: number;
    };
    const pcs = ((window as unknown as { __iaPcs?: RTCPeerConnection[] }).__iaPcs ?? []).filter(
      (pc) => pc.connectionState !== 'closed',
    );
    const out = {
      channelBytes: {} as Record<string, number>,
      transportBytes: 0,
      audioIn: { live: false, unmuted: false, bytes: 0 },
      audioOutReports: 0,
      audioRtpBytes: 0,
    };
    for (const pc of pcs) {
      const stats = await pc.getStats();
      stats.forEach((s: S) => {
        if (s.type === 'data-channel' && s.label)
          out.channelBytes[s.label] = (out.channelBytes[s.label] ?? 0) + (s.bytesReceived ?? 0);
        else if (s.type === 'transport') out.transportBytes += (s.bytesReceived ?? 0) + (s.bytesSent ?? 0);
        else if (s.type === 'inbound-rtp' && s.kind === 'audio') {
          out.audioIn.bytes += s.bytesReceived ?? 0;
          out.audioRtpBytes += (s.bytesReceived ?? 0) + (s.headerBytesReceived ?? 0);
        } else if (s.type === 'outbound-rtp' && s.kind === 'audio')
          out.audioRtpBytes += (s.bytesSent ?? 0) + (s.headerBytesSent ?? 0);
        else if (s.type === 'remote-inbound-rtp' && s.kind === 'audio')
          out.audioOutReports += s.roundTripTimeMeasurements ?? (s.roundTripTime !== undefined ? 1 : 0);
      });
    }
    const el = [...document.querySelectorAll('audio')].find((a) => a.srcObject instanceof MediaStream);
    const track = (el?.srcObject as MediaStream | undefined)?.getAudioTracks()[0];
    out.audioIn.live = track?.readyState === 'live';
    out.audioIn.unmuted = track ? !track.muted : false;
    return out;
  });
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
