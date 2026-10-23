/** `buildIceServers(principal)` (contracts section 6.11): one builder for GET /ice and every WS ICE field. */
import { buildIceConfig, type IceConfig, type TurnPrincipal } from '@indiansassist/shared';
import type { Config } from '../config.js';

export function buildIceServers(config: Config, principal: TurnPrincipal, nowMs: number = Date.now()): IceConfig {
  return buildIceConfig({
    stunUrls: config.stunUrls,
    turnUrls: config.turnUrls,
    secret: config.turnSecret,
    principal,
    ttlSeconds: config.turnTtlSeconds,
    nowMs,
  });
}

/** Host part of a `stun:` / `turn:` / `turns:` URL (`turn:host:3478?transport=udp` -> `host`). */
export function iceUrlHost(url: string): string | null {
  const m = /^(?:stuns?|turns?):(?:\/\/)?(\[[^\]]+\]|[^:?/]+)/i.exec(url.trim());
  return m ? m[1]!.replace(/^\[|\]$/g, '').toLowerCase() : null;
}

/** ICE hosts that are not under one of the deployment's own host suffixes (residency report). */
export function thirdPartyIceHosts(urls: readonly string[], ownSuffixes: readonly string[]): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    const host = iceUrlHost(u);
    if (!host) continue;
    const own = ownSuffixes.some((s) => {
      const suf = s.trim().toLowerCase().replace(/^\./, '');
      return suf !== '' && (host === suf || host.endsWith(`.${suf}`));
    });
    if (!own) out.add(host);
  }
  return [...out];
}
