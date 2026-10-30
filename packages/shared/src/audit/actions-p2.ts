/**
 * Phase B audit actions (docs/specs/phase-b-contracts.md sections 3.6, 3.7): for each action the chain shape (what
 * `insertAuditEntry` validates and hashes), the Desk wire shape (`desk.event`) and the console wire shape
 * (`POST /sessions/:id/events`). The wire carries a plaintext `host`; the chain carries `hostHash` instead
 * (`hostToHash`), and neither accepts the other's key. Every schema is strict.
 */
import { z } from 'zod';
import {
  BACKSTAGE_ACTIONS,
  BACKSTAGE_OUTCOMES,
  FIELD_KINDS,
  LIMITS,
  MASK_REFUSE_CAUSES,
  MASK_RESTORE_CAUSES,
  MASK_SCOPES,
  MIRROR_SCOPES,
  MIRROR_START_REASONS,
  MIRROR_STOP_REASONS,
  STORED_CONSENT_LEVELS,
} from '../enums.js';
import { BROWSER_INPUT_MODES, CONTROL_ERROR_CODES, CONTROL_OPS, TAB_ACTION_KINDS } from '../extension/control.js';
import { controlInputOsDesk, controlInputOsUser, controlRefusedP3 } from './actions-p3.js';
import { isWireHost } from '../extension/deny-list.js';
import { sanitiseText } from './sanitise.js';

const int = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const tabId = z.number().int().nonnegative().max(0x7fffffff);
const nodeId = z.number().int().nonnegative().max(0x7fffffff);
const tabIds = z.array(tabId).min(1).max(LIMITS.tabsCloseMax);
const hash = z.string().regex(/^[0-9a-f]{64}$/, 'expected sha256 hex');
export const opIdSchema = z.string().regex(/^[0-9a-f]{16}$/, 'expected a 16-hex-char opId');
const opId = opIdSchema;
/**
 * Both consent-level families (Phase C section 3.4): a P3 session writes `level.requested`, `consent.level_refused` and
 * `consent.level_changed` with its own levels; the api checks the family against the session tier.
 */
const level = z.enum(STORED_CONSENT_LEVELS);
const B_INPUT_KINDS = ['pointer', 'key', 'scroll', 'fill'] as const;
const scope = z.enum(MASK_SCOPES);
/** A wire `host`: hostname only (lower-case, IDNA-ASCII, no port / path / wildcard, <= 253). */
export const wireHostSchema = z.string().max(LIMITS.policyHostPatternMax).refine(isWireHost, 'host must be a bare lower-case hostname');
const kinds = z
  .array(z.enum(B_INPUT_KINDS))
  .min(1)
  .max(B_INPUT_KINDS.length)
  .refine((k) => new Set(k).size === k.length, 'kinds must be unique');
const errorCode = z.enum(CONTROL_ERROR_CODES);
const tabKind = z.enum(TAB_ACTION_KINDS);

// ---------- shapes identical on the wire and in the chain ----------

const same = {
  'mirror.started': z.strictObject({
    reason: z.enum(MIRROR_START_REASONS),
    scope: z.enum(MIRROR_SCOPES),
    level,
    tabCount: int,
    tabId: tabId.optional(),
  }),
  'mirror.stopped': z.strictObject({ reason: z.enum(MIRROR_STOP_REASONS), tabId: tabId.optional(), batches: int, bytes: int }),
  'mask.requested': z.strictObject({ tabId, scope, nodeId: nodeId.optional(), opId }),
  'mask.override': z.strictObject({
    tabId,
    scope,
    nodeId: nodeId.optional(),
    fieldKind: z.enum(FIELD_KINDS).optional(),
    outline: z.strictObject({ w: z.number().nonnegative().max(1e6), h: z.number().nonnegative().max(1e6) }).optional(),
    opId,
    ttlMs: z.number().int().min(1).max(LIMITS.revealTtlMs),
  }),
  'mask.refused': z.strictObject({
    tabId,
    scope,
    nodeId: nodeId.optional(),
    fieldKind: z.enum(FIELD_KINDS).optional(),
    opId,
    cause: z.enum(MASK_REFUSE_CAUSES),
  }),
  'mask.restored': z.strictObject({ tabId, scope, durationMs: int, by: z.enum(MASK_RESTORE_CAUSES) }),
  'level.requested': z.strictObject({ level, opId }),
  'consent.level_refused': z.strictObject({ from: level, requested: level, opId, timeout: z.boolean() }),
} as const;

const controlInputDesk = z.strictObject({
  mode: z.enum(BROWSER_INPUT_MODES),
  tabId,
  count: int,
  kinds,
  windowMs: int,
  refused: int,
});
const controlInputUser = z.strictObject({ mode: z.enum(BROWSER_INPUT_MODES), tabId, count: int, kinds, windowMs: int });
const backstageExitDesk = z.strictObject({ tabId, outcome: z.enum(BACKSTAGE_OUTCOMES), durationMs: int, opId: opId.optional() });
const backstageExitUser = z.strictObject({ tabId, action: z.enum(BACKSTAGE_ACTIONS), opId });

// ---------- wire shapes ----------

/** Desk wire `data` per action (`desk.event`, section 3.6); the `file.*` branch lives in the signal schemas. */
export const DESK_EVENT_DATA = {
  'mirror.started': same['mirror.started'],
  'mirror.stopped': same['mirror.stopped'],
  'tab.action': z.strictObject({
    kind: tabKind,
    opId,
    tabId: tabId.optional(),
    tabIds: tabIds.optional(),
    host: wireHostSchema.optional(),
    ok: z.boolean(),
    error: errorCode.optional(),
  }),
  'control.input': controlInputDesk,
  'mask.override': same['mask.override'],
  'mask.refused': same['mask.refused'],
  'mask.restored': same['mask.restored'],
  'consent.level_refused': same['consent.level_refused'],
  'backstage.enter': z.strictObject({ tabId: tabId.optional(), host: wireHostSchema, opId, ok: z.boolean(), error: errorCode.optional() }),
  'backstage.exit': backstageExitDesk,
} as const;
export type DeskEventP2Action = keyof typeof DESK_EVENT_DATA;
export const DESK_EVENT_P2_ACTIONS = Object.keys(DESK_EVENT_DATA) as DeskEventP2Action[];
/** Desk actions that may carry a `reason` (the technician's reason copied from the op). */
export const DESK_EVENT_REASON_ACTIONS = ['mask.override', 'mask.refused', 'consent.level_refused'] as const;

/** Console wire `data` per action (`POST /sessions/:id/events`, section 3.6, Y24). */
export const ASSIST_EVENT_DATA = {
  'tab.action': z.strictObject({ kind: tabKind, opId, tabId: tabId.optional(), tabIds: tabIds.optional(), host: wireHostSchema.optional() }),
  'control.input': controlInputUser,
  'mask.requested': same['mask.requested'],
  'level.requested': same['level.requested'],
  'backstage.enter': z.strictObject({ host: wireHostSchema, opId }),
  'backstage.exit': backstageExitUser,
} as const;
export type AssistEventP2Action = keyof typeof ASSIST_EVENT_DATA;
export const ASSIST_EVENT_P2_ACTIONS = Object.keys(ASSIST_EVENT_DATA) as AssistEventP2Action[];
/** Console actions that carry the technician's typed reason in the `reason` column. */
export const ASSIST_EVENT_REASON_ACTIONS = ['mask.requested', 'level.requested'] as const;

export function deskEventDataSchema<A extends DeskEventP2Action>(action: A): (typeof DESK_EVENT_DATA)[A] {
  const s = DESK_EVENT_DATA[action];
  if (!s) throw new Error(`not a desk.event action: ${String(action)}`);
  return s;
}

export function assistEventDataSchema<A extends AssistEventP2Action>(action: A): (typeof ASSIST_EVENT_DATA)[A] {
  const s = ASSIST_EVENT_DATA[action];
  if (!s) throw new Error(`not a console event action: ${String(action)}`);
  return s;
}

// ---------- chain shapes ----------

/** Chain `data` of the Phase B actions (merged into AUDIT_ACTIONS / auditDataSchema by actions.ts). */
export const P2_CHAIN_SCHEMAS = {
  ...same,
  'tab.action': z.union([
    z.strictObject({ kind: tabKind, opId, tabId: tabId.optional(), tabIds: tabIds.optional(), hostHash: hash.optional(), ok: z.boolean(), error: errorCode.optional() }),
    z.strictObject({ kind: tabKind, opId, tabId: tabId.optional(), tabIds: tabIds.optional(), hostHash: hash.optional() }),
  ]),
  'control.input': z.union([controlInputDesk, controlInputUser, controlInputOsDesk, controlInputOsUser]),
  'backstage.enter': z.union([
    z.strictObject({ tabId: tabId.optional(), hostHash: hash, opId, ok: z.boolean(), error: errorCode.optional() }),
    z.strictObject({ hostHash: hash, opId }),
  ]),
  'backstage.exit': z.union([backstageExitDesk, backstageExitUser]),
  'consent.level_changed': z.strictObject({ from: level, to: level, requestedBy: z.enum(['assist', 'desk']), opId: opId.optional() }),
  'consent.backstage_changed': z.strictObject({ from: z.boolean(), to: z.boolean() }),
  'mirror.relayed': z.strictObject({ mirrorFrames: int, mirrorBytes: int, controlFrames: int, dropped: int }),
  'org.policy_updated': z.strictObject({ fields: z.array(z.string().transform((s) => sanitiseText(s, 100))).max(50) }),
  'recording.deleted': z.strictObject({
    recordingId: z.string().transform((s) => sanitiseText(s, 100)),
    cause: z.enum(['manual', 'retention']),
    bytes: int,
  }),
  /**
   * The server refused a `control.relay` request above the Desk's granted level (amendment by the shared/api
   * engineer, see the Phase B report): `op`, the request's `opId`, the level it needs and the level in force.
   */
  'control.refused': z.union([
    z.strictObject({
      op: z.enum(CONTROL_OPS as [string, ...string[]]),
      opId,
      required: level,
      granted: level.nullable(),
      transport: z.literal('relay'),
      suppressed: int.optional(),
    }),
    controlRefusedP3,
  ]),
} as const;

export const P2_AUDIT_ACTIONS = [
  'mirror.started',
  'mirror.stopped',
  'tab.action',
  'control.input',
  'mask.requested',
  'mask.override',
  'mask.refused',
  'mask.restored',
  'level.requested',
  'consent.level_refused',
  'backstage.enter',
  'backstage.exit',
  'consent.level_changed',
  'consent.backstage_changed',
  'mirror.relayed',
  'org.policy_updated',
  'recording.deleted',
  'control.refused',
] as const satisfies readonly (keyof typeof P2_CHAIN_SCHEMAS)[];

/**
 * Wire -> chain host mapping (section 3.6): removes `host` and, when it was present, adds
 * `hostHash = hasher(host)`. Returns the plaintext host for the mutable `session_host` row.
 */
export function hostToHash<T extends Record<string, unknown>>(
  data: T,
  hasher: (host: string) => string,
): { data: Omit<T, 'host'> & { hostHash?: string }; host: string | null } {
  const { host, ...rest } = data as T & { host?: unknown };
  if (typeof host !== 'string') return { data: rest as Omit<T, 'host'>, host: null };
  return { data: { ...(rest as Omit<T, 'host'>), hostHash: hasher(host) }, host };
}
