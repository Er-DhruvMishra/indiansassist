/** Shared helpers for the Package 1 e2e: screenshots, media probes, canvas pixel checks, console capture. */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';

export const ARTIFACTS = resolve(dirname(fileURLToPath(import.meta.url)), 'artifacts');

let shotIndex = 0;
export const shots: string[] = [];

/** Full-page screenshot into apps/web/e2e/artifacts/NN-name.png. */
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

export type VideoProbe = { width: number; height: number; time: number; readyState: number };

/** The Assist console's remote <video> (the one RemoteView draws into the watermark canvas). */
export async function probeRemoteVideo(page: Page): Promise<VideoProbe | null> {
  return page.evaluate(() => {
    const v = [...document.querySelectorAll('video')].find(
      (x) => x.srcObject instanceof MediaStream && x.getAttribute('aria-hidden') === 'true',
    );
    if (!v) return null;
    return { width: v.videoWidth, height: v.videoHeight, time: v.currentTime, readyState: v.readyState };
  });
}

/** Number of non-transparent pixels on a canvas (annotation overlays are transparent except for the ink). */
export async function inkPixels(canvas: Locator): Promise<number> {
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    if (c.width === 0 || c.height === 0) return 0;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) n++;
    return n;
  });
}

/** Number of distinct-ish colours in a sample of a canvas (proves real video frames were drawn, not a blank). */
export async function canvasHasContent(canvas: Locator): Promise<boolean> {
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    if (c.width === 0 || c.height === 0) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < data.length && seen.size < 8; i += 4 * 97)
      seen.add((data[i]! >> 4) * 256 + (data[i + 1]! >> 4) * 16 + (data[i + 2]! >> 4));
    return seen.size >= 3;
  });
}

/**
 * Init script (runs before any page script): keeps every RTCPeerConnection the page creates on
 * `window.__iaPcs`, so the test can read `getStats()` (inbound audio) without a hook in the app.
 */
export function recordPeerConnections(): void {
  const w = window as unknown as { __iaPcs: RTCPeerConnection[]; RTCPeerConnection: typeof RTCPeerConnection };
  w.__iaPcs = [];
  const Orig = w.RTCPeerConnection;
  if (!Orig) return;
  class Recording extends Orig {
    constructor(cfg?: RTCConfiguration) {
      super(cfg);
      w.__iaPcs.push(this);
    }
  }
  w.RTCPeerConnection = Recording;
}

export type AudioProbe = { live: boolean; unmuted: boolean; bytesReceived: number };

/**
 * State of the remote audio on one side: the hidden <audio> element's track (live and receiving, i.e. not
 * muted by the transport) plus the sum of `inbound-rtp` audio `bytesReceived` across open peer connections.
 */
export async function probeRemoteAudio(page: Page): Promise<AudioProbe> {
  return page.evaluate(async () => {
    const el = [...document.querySelectorAll('audio')].find((a) => a.srcObject instanceof MediaStream);
    const track = (el?.srcObject as MediaStream | undefined)?.getAudioTracks()[0];
    const pcs = ((window as unknown as { __iaPcs?: RTCPeerConnection[] }).__iaPcs ?? []).filter(
      (pc) => pc.connectionState !== 'closed',
    );
    let bytesReceived = 0;
    for (const pc of pcs) {
      const stats = await pc.getStats();
      stats.forEach((s: { type: string; kind?: string; bytesReceived?: number }) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') bytesReceived += s.bytesReceived ?? 0;
      });
    }
    return { live: track?.readyState === 'live', unmuted: track ? !track.muted : false, bytesReceived };
  });
}
