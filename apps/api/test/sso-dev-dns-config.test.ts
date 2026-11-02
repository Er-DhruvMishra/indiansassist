/**
 * Phase E section 10, `SSO_DEV_DNS_SERVERS`: a development seam that points the SSO domain TXT proof at a local fake
 * DNS server. A fake resolver would let anyone "prove" any domain, so the seam must never exist in production and
 * only on a node that already allows loopback egress for local fakes.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const opts = { persistSecrets: false } as const;

describe('SSO_DEV_DNS_SERVERS', () => {
  it('is a boot problem with NODE_ENV=production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', SSO_DEV_DNS_SERVERS: '127.0.0.1:5391' }, opts)).toThrow(
      /SSO_DEV_DNS_SERVERS must not be set with NODE_ENV=production/,
    );
  });

  it('needs EGRESS_ALLOW_LOOPBACK', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', SSO_DEV_DNS_SERVERS: '127.0.0.1:5391' }, opts)).toThrow(
      /SSO_DEV_DNS_SERVERS needs EGRESS_ALLOW_LOOPBACK=1/,
    );
  });

  it('refuses an entry that is not host:port', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', EGRESS_ALLOW_LOOPBACK: '1', SSO_DEV_DNS_SERVERS: '127.0.0.1' }, opts),
    ).toThrow(/entry "127.0.0.1" must be host:port/);
  });

  it('is parsed into config.egress.devDnsServers outside production with loopback egress', () => {
    const c = loadConfig(
      { NODE_ENV: 'test', EGRESS_ALLOW_LOOPBACK: '1', SSO_DEV_DNS_SERVERS: ' 127.0.0.1:5391 , [::1]:5392 ' },
      opts,
    );
    expect(c.egress.devDnsServers).toEqual(['127.0.0.1:5391', '[::1]:5392']);
  });

  it('is empty when unset', () => {
    expect(loadConfig({ NODE_ENV: 'test' }, opts).egress.devDnsServers).toEqual([]);
  });
});
