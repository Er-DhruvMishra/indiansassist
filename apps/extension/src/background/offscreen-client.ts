/**
 * The worker's handle on the offscreen document (section 7 "Offscreen document decision"): created at
 * `consent.ok` (WEB_RTC + USER_MEDIA), closed at hard rule 2 teardown. Requests go over the bus addressed
 * `to: 'offscreen'`.
 */
import { ext } from '../shared/api';
import { sendBus } from '../shared/bus';
import { OFFSCREEN_PATH } from '../shared/constants';
import type { WorkerToOffscreen } from '../shared/bus-schemas';

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type OffscreenMsg = DistOmit<WorkerToOffscreen, 'to'>;

export class OffscreenClient {
  private creating: Promise<void> | null = null;

  async exists(): Promise<boolean> {
    const rt = ext().runtime as typeof chrome.runtime & { getContexts?: (f: object) => Promise<unknown[]> };
    if (typeof rt.getContexts === 'function') {
      const ctx = await rt.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [rt.getURL(OFFSCREEN_PATH)] });
      return ctx.length > 0;
    }
    const pong = await sendBus<{ ok?: boolean }>({ to: 'offscreen', t: 'ping' });
    return pong?.ok === true;
  }

  async ensure(): Promise<void> {
    if (await this.exists()) return;
    if (!this.creating) {
      this.creating = ext()
        .offscreen.createDocument({
          url: OFFSCREEN_PATH,
          reasons: ['WEB_RTC' as chrome.offscreen.Reason, 'USER_MEDIA' as chrome.offscreen.Reason],
          justification: 'WebRTC peer connection and microphone for the support session',
        })
        .catch((e: unknown) => {
          if (!String(e).includes('single offscreen')) throw e;
        })
        .finally(() => {
          this.creating = null;
        });
    }
    await this.creating;
  }

  send<T = unknown>(msg: OffscreenMsg): Promise<T | undefined> {
    return sendBus<T>({ ...msg, to: 'offscreen' } as WorkerToOffscreen & { to: 'offscreen' });
  }

  async close(): Promise<void> {
    await this.send({ t: 'pc.close' });
    try {
      if (await this.exists()) await ext().offscreen.closeDocument();
    } catch {
      /* already closed */
    }
  }
}
