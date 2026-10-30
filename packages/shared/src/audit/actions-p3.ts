/**
 * Phase C audit actions (docs/specs/phase-c-contracts.md sections 3.8, 7.5, 8.5, 2.2, 2.4): the chain shapes
 * (what `insertAuditEntry` validates and hashes) and the two wire shapes, the native Desk's `desk.event` and the
 * console's `POST /sessions/:id/events`. Every schema is strict; content (clipboard text, typed text, playbook
 * output) never enters the chain, only counts and hashes.
 */
import { z } from 'zod';
import {
  AGENT_ARCHES,
  AGENT_CONSENT_LEVELS,
  AGENT_PLATFORMS,
  ELEVATION_DENY_CAUSES,
  ELEVATION_FAIL_ERRORS,
  LIMITS,
  PLAYBOOK_ERRORS,
  PLAYBOOK_INTERPRETERS,
  PLAYBOOK_RAN_AS,
  SEC_FAIL_REASONS,
} from '../enums.js';
import { sanitiseText } from './sanitise.js';

const int = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/, 'expected sha256 hex');
const opId = z.string().regex(/^[0-9a-f]{16}$/, 'expected a 16-hex-char opId');
const runId = z.string().regex(/^[0-9a-f]{32}$/, 'expected a 32-hex-char runId');
const id = z.string().transform((s) => sanitiseText(s, 100));
const monitorId = z.number().int().min(1).max(LIMITS.monitorsMax);
const osKinds = z
  .array(z.enum(['pointer', 'scroll', 'key', 'text']))
  .min(1)
  .max(4)
  .refine((k) => new Set(k).size === k.length, 'kinds must be unique');

/**
 * `control.refused`, P3 shape (amendment of the shared/api stream, see the Phase C report): the server refused a
 * console report of input that needs a higher P3 level than the session holds (`os.*` gating by level). The B relay
 * shape stays as it was.
 */
export const controlRefusedP3 = z.strictObject({
  action: z.enum(['control.input', 'input.text_burst', 'clipboard.sync', 'elevation.requested']),
  required: z.enum(AGENT_CONSENT_LEVELS),
  granted: z.enum(AGENT_CONSENT_LEVELS).nullable(),
  transport: z.literal('attestation'),
});

/** `control.input` with `mode: 'os'` (section 3.8): per (monitorId, mode) over 10 s, `tabId` absent. */
export const controlInputOsDesk = z.strictObject({
  mode: z.literal('os'),
  monitorId,
  count: int,
  kinds: osKinds,
  windowMs: int,
  textChars: int,
  refused: int,
});
export const controlInputOsUser = z.strictObject({
  mode: z.literal('os'),
  monitorId,
  count: int,
  kinds: osKinds,
  windowMs: int,
  textChars: int,
});

const same = {
  'input.text_burst': z.strictObject({ chars: int, windowMs: int, monitorId }),
  'clipboard.sync': z.strictObject({ toAssist: int, toDesk: int, bytes: int, windowMs: int }),
  'sec.failed': z.strictObject({ reason: z.enum(SEC_FAIL_REASONS), channel: z.string().max(32).optional() }),
} as const;

const playbookRunDesk = z.strictObject({
  playbookId: id,
  bodyHash: hash,
  runId,
  opId,
  exit: z.number().int().nullable(),
  durationMs: int,
  truncated: z.boolean(),
  ranAs: z.enum(PLAYBOOK_RAN_AS),
  error: z.enum(PLAYBOOK_ERRORS).optional(),
});

/** Native Desk wire `data` per P3 action (`desk.event`, section 3.8); `control.input` is the `os` branch. */
export const DESK_EVENT_P3_DATA = {
  'control.input': controlInputOsDesk,
  'input.text_burst': same['input.text_burst'],
  'clipboard.sync': same['clipboard.sync'],
  'elevation.denied': z.strictObject({ opId, cause: z.enum(ELEVATION_DENY_CAUSES) }),
  'elevation.failed': z.strictObject({ opId, error: z.enum(ELEVATION_FAIL_ERRORS) }),
  'playbook.run': playbookRunDesk,
  'sec.failed': same['sec.failed'],
  'a11y.state': z.strictObject({ enabled: z.boolean() }),
} as const;
/** The `desk.event` actions Phase C adds (`control.input` already exists from Phase B). */
export const DESK_EVENT_P3_ACTIONS = [
  'input.text_burst',
  'clipboard.sync',
  'elevation.denied',
  'elevation.failed',
  'playbook.run',
  'sec.failed',
  'a11y.state',
] as const satisfies readonly (keyof typeof DESK_EVENT_P3_DATA)[];
export type DeskEventP3Action = (typeof DESK_EVENT_P3_ACTIONS)[number];
/** P3 Desk actions that may carry the technician's reason. */
export const DESK_EVENT_P3_REASON_ACTIONS = ['elevation.denied'] as const;

/** Console wire `data` per P3 action (`POST /sessions/:id/events`, section 3.8). */
export const ASSIST_EVENT_P3_DATA = {
  'control.input': controlInputOsUser,
  'input.text_burst': same['input.text_burst'],
  'clipboard.sync': same['clipboard.sync'],
  'monitor.selected': z.strictObject({
    monitorIds: z
      .array(monitorId)
      .min(1)
      .max(LIMITS.monitorsMax)
      .refine((a) => new Set(a).size === a.length, 'unique'),
    opId,
  }),
  'elevation.requested': z.strictObject({ opId }),
  'sec.failed': same['sec.failed'],
  'sec.verified': z
    .strictObject({
      sas: z
        .string()
        .regex(/^\d{6}$/)
        .nullable(),
      gen: z.number().int().nonnegative().max(65535),
      skipped: z.literal(true).optional(),
    })
    .refine((d) => (d.sas === null) === (d.skipped === true), 'a skipped confirmation has sas null, a typed one a code'),
} as const;
export const ASSIST_EVENT_P3_ACTIONS = [
  'input.text_burst',
  'clipboard.sync',
  'monitor.selected',
  'elevation.requested',
  'sec.failed',
  'sec.verified',
] as const satisfies readonly (keyof typeof ASSIST_EVENT_P3_DATA)[];
export type AssistEventP3Action = (typeof ASSIST_EVENT_P3_ACTIONS)[number];
/** P3 console actions whose `reason` column carries the technician's typed reason. */
export const ASSIST_EVENT_P3_REASON_ACTIONS = ['elevation.requested'] as const;

/** Chain `data` of the new Phase C actions (merged into AUDIT_ACTIONS / auditDataSchema by actions.ts). */
export const P3_CHAIN_SCHEMAS = {
  'consent.clipboard_changed': z.strictObject({ from: z.boolean(), to: z.boolean() }),
  'consent.monitors_changed': z.strictObject({ from: int, to: int }),
  'input.text_burst': same['input.text_burst'],
  'sec.verified': ASSIST_EVENT_P3_DATA['sec.verified'],
  'sec.failed': same['sec.failed'],
  'elevation.handover_minted': z.strictObject({ opId, expiresAt: z.string().transform((s) => sanitiseText(s, 40)) }),
  'elevation.granted': z.strictObject({ opId, elevation: z.literal('admin'), claimed: z.literal(true) }),
  'elevation.denied': DESK_EVENT_P3_DATA['elevation.denied'],
  'elevation.failed': DESK_EVENT_P3_DATA['elevation.failed'],
  'a11y.state': DESK_EVENT_P3_DATA['a11y.state'],
  'clipboard.sync': same['clipboard.sync'],
  'monitor.selected': ASSIST_EVENT_P3_DATA['monitor.selected'],
  'playbook.run': playbookRunDesk,
  'playbook.run_requested': z.strictObject({ playbookId: id, bodyHash: hash, runId, opId }),
  'playbook.created': z.strictObject({
    playbookId: id,
    bodyHash: hash,
    interpreter: z.enum(PLAYBOOK_INTERPRETERS),
    requiresElevation: z.boolean(),
  }),
  'playbook.updated': z.strictObject({
    playbookId: id,
    fields: z.array(z.string().transform((s) => sanitiseText(s, 40))).max(20),
    bodyHash: hash,
  }),
  'playbook.deleted': z.strictObject({ playbookId: id }),
  'download.served': z.strictObject({
    tokenId: id,
    platform: z.enum(AGENT_PLATFORMS),
    arch: z.enum(AGENT_ARCHES),
    version: z.string().transform((s) => sanitiseText(s, 40)),
    sha256: hash,
  }),
  'token.iaconfig_issued': z.strictObject({ tokenId: id }),
} as const;

export const P3_AUDIT_ACTIONS = [
  'consent.clipboard_changed',
  'consent.monitors_changed',
  'input.text_burst',
  'sec.verified',
  'sec.failed',
  'elevation.handover_minted',
  'elevation.granted',
  'elevation.denied',
  'elevation.failed',
  'a11y.state',
  'clipboard.sync',
  'monitor.selected',
  'playbook.run',
  'playbook.run_requested',
  'playbook.created',
  'playbook.updated',
  'playbook.deleted',
  'download.served',
  'token.iaconfig_issued',
] as const satisfies readonly (keyof typeof P3_CHAIN_SCHEMAS)[];
export type P3AuditAction = (typeof P3_AUDIT_ACTIONS)[number];
