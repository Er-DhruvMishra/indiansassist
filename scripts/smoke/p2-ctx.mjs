// Context object of the Phase B smoke flow (same shape as smoke.mjs's, plus the extension Origin).

import { ApiClient } from './http.mjs';

/** `EXTENSION_ID_PLACEHOLDER` of @indiansassist/shared (Phase B 2.1 J4), duplicated so no import is needed here. */
export const EXTENSION_ID_PLACEHOLDER_FALLBACK = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * @param {{ apiUrl?: string, webOrigin?: string, signalUrl?: string, extensionId: string, timeoutMs?: number,
 *           fetchImpl?: typeof fetch }} opts
 */
export function p2Ctx(opts) {
  const apiUrl = (opts.apiUrl ?? 'http://localhost:4000').replace(/\/+$/, '');
  if (!/^[a-p]{32}$/.test(opts.extensionId)) throw new Error(`extension id ${opts.extensionId} is not 32 chars a-p`);
  return {
    cfg: {
      apiUrl,
      webOrigin: opts.webOrigin ?? null,
      signalUrl: opts.signalUrl ?? null,
      signalUrlOverride: opts.signalUrl ?? null,
      extensionOrigin: `chrome-extension://${opts.extensionId}`,
      timeoutMs: opts.timeoutMs ?? 5000,
    },
    api: new ApiClient(apiUrl, { origin: opts.webOrigin ?? null, fetchImpl: opts.fetchImpl }),
    fetchImpl: opts.fetchImpl,
    shared: null,
    state: {},
    sockets: [],
  };
}
