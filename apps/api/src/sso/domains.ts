/**
 * Phase E section 3.2: verified email domains. Proof is a DNS TXT record at `_indiansassist.<domain>` whose value is
 * exactly `ia-verify=<token>`, resolved through `ctx.dnsResolver.resolveTxt` (injectable; the system resolver in
 * production). Uniqueness among verified claims is per region (partial unique index); the sweeper re-checks verified
 * domains weekly and lapses one after three consecutive misses (rule 3.2d).
 */
import { Resolver } from 'node:dns/promises';
import { LIMITS, ssoTxtName, ssoTxtValue, type SsoDomain } from '@indiansassist/shared';
import { getOrg, type SsoDomainRow } from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { systemActor, writeAudit } from '../lib/audit.js';
import { listDomainsDueForRecheck, updateDomain } from './repo.js';

export const DOMAIN_LAPSE_MISSES = 3;
const RECHECK_BATCH = 25;

export function toSsoDomain(r: SsoDomainRow): SsoDomain {
  return {
    id: r.id,
    domain: r.domain,
    status: r.status,
    txtName: ssoTxtName(r.domain),
    txtValue: ssoTxtValue(r.verifyToken),
    verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null,
    lastCheckedAt: r.lastCheckedAt ? r.lastCheckedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

let devResolver: { servers: string; resolver: Resolver } | null = null;

/**
 * The TXT lookup of rule 3.2b: `ctx.dnsResolver.resolveTxt`. `config.egress.devDnsServers` (`SSO_DEV_DNS_SERVERS`,
 * section 10) points TXT proofs at a local fake DNS server so the smoke run against a real api process can publish a
 * record. config.ts refuses it in production and without loopback egress, and this check repeats both conditions.
 */
export function txtLookup(ctx: AppContext): (host: string) => Promise<string[][]> {
  const servers = (ctx.config.egress.devDnsServers ?? []).join(',');
  if (servers && !ctx.config.production && ctx.config.egress.allowLoopback) {
    if (!devResolver || devResolver.servers !== servers) {
      const resolver = new Resolver({ timeout: 2000, tries: 1 });
      resolver.setServers(servers.split(',').map((s) => s.trim()).filter(Boolean));
      devResolver = { servers, resolver };
    }
    const r = devResolver.resolver;
    return (host) => r.resolveTxt(host);
  }
  return (host) => ctx.dnsResolver.resolveTxt(host);
}

/** Resolves the proof record; `found` = at most 5 joined values, each cut to 100 chars (`409 domain_unverified`). */
export async function checkDomainTxt(ctx: AppContext, domain: string, token: string): Promise<{ matched: boolean; found: string[] }> {
  let records: string[][];
  try {
    records = await txtLookup(ctx)(ssoTxtName(domain));
  } catch {
    records = [];
  }
  const joined = records.map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)));
  const want = ssoTxtValue(token);
  return { matched: joined.includes(want), found: joined.slice(0, 5).map((s) => s.slice(0, 100)) };
}

/**
 * Rule 3.2d: re-resolves verified domains not checked for `LIMITS.ssoDomainRecheckHours`; a hit resets the miss count,
 * the third consecutive miss sets `lapsed` and chains `sso.domain_lapsed`. Bounded per pass (the sweeper runs often).
 */
export async function recheckDomains(ctx: AppContext, now: Date = new Date()): Promise<{ checked: number; lapsed: number }> {
  const before = new Date(now.getTime() - LIMITS.ssoDomainRecheckHours * 3_600_000);
  const due = await listDomainsDueForRecheck(ctx.db, before, RECHECK_BATCH);
  let lapsed = 0;
  for (const d of due) {
    const r = await checkDomainTxt(ctx, d.domain, d.verifyToken);
    if (r.matched) {
      await updateDomain(ctx.db, d.id, { lastCheckedAt: now, misses: 0 });
      continue;
    }
    const misses = d.misses + 1;
    if (misses < DOMAIN_LAPSE_MISSES) {
      await updateDomain(ctx.db, d.id, { lastCheckedAt: now, misses });
      continue;
    }
    const org = await getOrg(ctx.db, d.orgId);
    await ctx.db.transaction(async (tx) => {
      await updateDomain(tx, d.id, { lastCheckedAt: now, misses, status: 'lapsed' });
      if (org) await writeAudit(ctx, tx, org, { actor: systemActor, action: 'sso.domain_lapsed', data: { domainId: d.id, domain: d.domain } });
    });
    lapsed++;
  }
  return { checked: due.length, lapsed };
}
