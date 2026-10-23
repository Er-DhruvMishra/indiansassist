/**
 * JSONL audit export format (contracts section 5.5): a header line, then one hashed entry (plus `id`, `hash`)
 * per line, `\n` terminated. Shared by the api (writer) and the web offline verifier (reader).
 */
import { z } from 'zod';
import { canonicalJson } from '../canonical.js';
import { REGIONS } from '../regions.js';
import { ACTOR_TYPES } from '../enums.js';
import { verifyChain, type ChainEntry, type VerifyResult } from './chain.js';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const auditExportHeaderSchema = z.object({
  ia_audit_export: z.literal(1),
  orgId: z.string(),
  orgSlug: z.string(),
  region: z.enum(REGIONS),
  exportedAt: z.string(),
  startSeq: z.number().int().min(1),
  startPrevHash: hex64,
  count: z.number().int().nonnegative(),
  keys: z.array(z.object({ kid: z.string(), pub: z.string() })),
});
export type AuditExportHeader = z.infer<typeof auditExportHeaderSchema>;

export const chainEntrySchema = z.object({
  id: z.string().optional(),
  seq: z.number().int().min(1),
  org_id: z.string(),
  session_id: z.string().nullable(),
  actor: z.object({ id: z.string().nullable(), label: z.string(), type: z.enum(ACTOR_TYPES) }),
  action: z.string(),
  reason: z.string().nullable(),
  region: z.enum(REGIONS),
  ts: z.string(),
  data: z.record(z.string(), z.any()),
  prev_hash: hex64,
  hash: hex64,
});

/** Serialises a header and entries as JSONL (each line canonical JSON, trailing newline). */
export function buildAuditJsonl(header: AuditExportHeader, entries: Iterable<ChainEntry>): string {
  const lines = [canonicalJson(header)];
  for (const e of entries) lines.push(canonicalJson(e));
  return lines.join('\n') + '\n';
}

export type ParsedAuditJsonl =
  | { ok: true; header: AuditExportHeader; entries: ChainEntry[] }
  | { ok: false; error: 'malformed'; line: number; message: string };

/** Parses a JSONL export. A file without a valid header (line 1) is malformed. */
export function parseAuditJsonl(text: string): ParsedAuditJsonl {
  const lines = text.split('\n').filter((l, i, all) => !(l === '' && i === all.length - 1));
  if (lines.length === 0) return { ok: false, error: 'malformed', line: 1, message: 'empty file' };
  let header: AuditExportHeader;
  try {
    const parsed = auditExportHeaderSchema.safeParse(JSON.parse(lines[0]!));
    if (!parsed.success) return { ok: false, error: 'malformed', line: 1, message: 'missing or invalid header' };
    header = parsed.data;
  } catch {
    return { ok: false, error: 'malformed', line: 1, message: 'header is not JSON' };
  }
  const entries: ChainEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      const parsed = chainEntrySchema.safeParse(JSON.parse(lines[i]!));
      if (!parsed.success) return { ok: false, error: 'malformed', line: i + 1, message: 'invalid entry' };
      entries.push(parsed.data as ChainEntry);
    } catch {
      return { ok: false, error: 'malformed', line: i + 1, message: 'entry is not JSON' };
    }
  }
  return { ok: true, header, entries };
}

export type JsonlVerifyResult = VerifyResult & {
  header?: AuditExportHeader;
  countMatches?: boolean;
  malformed?: string;
};

/**
 * Offline verification of an export: parses the header, then runs verifyChain with
 * `{ orgId, region, start: { seq: startSeq, prevHash: startPrevHash }, pubKeys: header.keys }`.
 */
export function verifyAuditJsonl(text: string): JsonlVerifyResult {
  const parsed = parseAuditJsonl(text);
  if (!parsed.ok) return { ok: false, checked: 0, tail: null, malformed: `line ${parsed.line}: ${parsed.message}` };
  const { header, entries } = parsed;
  const result = verifyChain(entries, {
    orgId: header.orgId,
    region: header.region,
    start: { seq: header.startSeq, prevHash: header.startPrevHash },
    pubKeys: header.keys,
  });
  return { ...result, header, countMatches: header.count === entries.length };
}
