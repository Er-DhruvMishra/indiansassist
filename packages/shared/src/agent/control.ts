/**
 * Phase C section 5.1: the native (`os.*`) control ops on the encrypted `ia.control`, their strict args, minimum
 * levels and the new error codes. Disjoint from the Phase B tab ops (`controlRequestSchema`): the agent answers
 * `not_supported` for every B op and the extension for every op here. Mirrored by `ia_core::types`
 * (`AGENT_CONTROL_OPS`, `agent_min_level_for`) and the Kotlin `AgentControl`; the cross-language list is
 * `test/fixtures/agent/agent-names.json`.
 */
import { z } from 'zod';
import {
  AGENT_CONSENT_LEVELS,
  CAPTURE_PATHS,
  ELEVATION_LEVELS,
  NAV_ACTIONS,
  PLAYBOOK_INTERPRETERS,
  QUALITY_PRESETS,
} from '../enums.js';
import type { AgentConsentLevel } from '../enums.js';
import { modifiersSchema } from '../extension/control.js';

const monitorId = z.number().int().min(1).max(16);
const coord = z.number().min(0).max(1);
const hex = (n: number) => z.string().regex(new RegExp(`^[0-9a-f]{${n}}$`));

/** `MonitorInfo` (section 3.6 M3), virtual-desktop pixels. */
export const monitorInfoSchema = z.strictObject({
  id: monitorId,
  name: z.string().max(64),
  primary: z.boolean(),
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  scale: z.number().positive(),
  mid: z.string().max(32).nullable(),
});
export type MonitorInfo = z.infer<typeof monitorInfoSchema>;

/** Strict args per op (section 5.1 table; `playbook.run` is the section 8.4 shape). */
export const AGENT_CONTROL_ARGS = {
  'os.monitors': z.strictObject({}),
  'os.monitor.select': z.strictObject({
    monitorIds: z
      .array(monitorId)
      .min(1)
      .max(16)
      .refine((a) => new Set(a).size === a.length, 'unique'),
  }),
  'os.quality': z.strictObject({ preset: z.enum(QUALITY_PRESETS) }),
  'os.pointer': z.strictObject({
    monitorId,
    kind: z.enum(['move', 'down', 'up', 'click', 'dblclick']),
    nx: coord,
    ny: coord,
    button: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(0),
    modifiers: modifiersSchema,
  }),
  'os.scroll': z.strictObject({
    monitorId,
    nx: coord,
    ny: coord,
    dx: z.number().int().min(-20).max(20),
    dy: z.number().int().min(-20).max(20),
  }),
  'os.key': z.strictObject({
    kind: z.enum(['down', 'up', 'press']),
    key: z.string().min(1).max(64),
    code: z.string().min(1).max(64),
    modifiers: modifiersSchema,
  }),
  'os.text': z.strictObject({ text: z.string().min(1).max(1024) }),
  'os.nav': z.strictObject({ action: z.enum(NAV_ACTIONS) }),
  'clipboard.set': z.strictObject({
    text: z
      .string()
      .min(1)
      .refine((t) => new TextEncoder().encode(t).length <= 65_536, 'at most 65536 UTF-8 bytes'),
  }),
  'os.input_lock': z.strictObject({ locked: z.boolean() }),
  'os.privacy_screen': z.strictObject({ on: z.boolean() }),
  /** Phase D section 5.4: Ctrl+Alt+Del through the service's `SendSAS` (P3 answers `not_supported { message: 'phase_d' }`). */
  'os.sas': z.strictObject({}),
  // B shape reused; `level` accepts both families, the agent answers `bad_args` for anything but `control`.
  'level.request': z.strictObject({ level: z.string().min(1).max(32), reason: z.string().max(500).optional() }),
  'elevation.request': z.strictObject({ reason: z.string().min(1).max(500) }),
  'playbook.run': z.strictObject({
    runId: hex(32),
    playbookId: z.uuid(),
    bodyHash: hex(64),
    body: z.string().refine((b) => new TextEncoder().encode(b).length <= 65_536, 'at most 65536 UTF-8 bytes'),
    interpreter: z.enum(PLAYBOOK_INTERPRETERS),
    args: z.record(z.string(), z.string()),
    requiresElevation: z.boolean(),
    timeoutSec: z.number().int().min(1).max(900),
  }),
  'playbook.cancel': z.strictObject({ runId: hex(32) }),
} as const;
export type AgentControlOp = keyof typeof AGENT_CONTROL_ARGS;
export const AGENT_CONTROL_OPS = Object.keys(AGENT_CONTROL_ARGS) as AgentControlOp[];

const MIN_LEVEL: Record<AgentControlOp, AgentConsentLevel> = {
  'os.monitors': 'view',
  'os.monitor.select': 'view',
  'os.quality': 'view',
  'os.pointer': 'control',
  'os.scroll': 'control',
  'os.key': 'control',
  'os.text': 'control',
  'os.nav': 'control',
  'clipboard.set': 'control',
  'os.input_lock': 'elevated',
  'os.privacy_screen': 'elevated',
  'os.sas': 'elevated',
  'level.request': 'view',
  'elevation.request': 'control',
  'playbook.run': 'control',
  'playbook.cancel': 'control',
};

/** `agentMinLevelFor(op, args)`: `playbook.run` needs `elevated` when `requiresElevation`. */
export function agentMinLevelFor(op: AgentControlOp, args?: unknown): AgentConsentLevel {
  if (op === 'playbook.run' && (args as { requiresElevation?: unknown } | undefined)?.requiresElevation === true)
    return 'elevated';
  return MIN_LEVEL[op];
}

/** Section 5.1: the `CONTROL_ERROR_CODES` additions (also appended to the B list). */
export const AGENT_CONTROL_ERROR_CODES = [
  'elevation_required',
  'no_such_monitor',
  'blocked_uipi',
  'secure_desktop',
  'secure_window',
  'clipboard_off',
  'hash_mismatch',
  'busy',
] as const;

const reqId = z.string().min(1).max(40);
const ts = z.number().int().nonnegative();

function req<O extends AgentControlOp>(op: O) {
  return z.strictObject({ t: z.literal('ctl.req'), id: reqId, op: z.literal(op), args: AGENT_CONTROL_ARGS[op], ts });
}

/** A native `ctl.req` (separate from B's `controlRequestSchema`, section 3.1 relay rule). */
export const agentControlRequestSchema = z.discriminatedUnion(
  'op',
  AGENT_CONTROL_OPS.map((op) => req(op)) as unknown as [ReturnType<typeof req>, ...ReturnType<typeof req>[]],
);

/**
 * `ctl.event capture.cause` (section 5.1); `wayland_unsupported` and `x11_lost` are the Linux causes of Phase E
 * section 7.4; `portal_denied` and `portal_closed` the portal causes of Phase F section 9.3; `sck_stopped` the macOS
 * ScreenCaptureKit stream stopping (Phase F section 17.2, revision 3). Mirrored by
 * `ia_core::capture_decision::CaptureCause` (same order, `ALL`).
 */
export const CAPTURE_CAUSES = [
  'start',
  'dda_lost',
  'secure_desktop',
  'recovered',
  'wayland_unsupported',
  'x11_lost',
  'portal_denied',
  'portal_closed',
  'sck_stopped',
] as const;
export type CaptureCause = (typeof CAPTURE_CAUSES)[number];

/** The new `ctl.event` kinds (section 5.1). */
export const AGENT_CONTROL_EVENT_KINDS = [
  'monitors',
  'capture',
  'agent_level',
  'clipboard',
  'elevation',
  'input_blocked',
  // Phase D rule 3.5b: the device-key attestation of the SAS of an auto-granted P4 session.
  'device_attest',
  // Phase F section 3.4b: the Desk user's Keep choice, reported read-only to the console.
  'keep',
] as const;
const ev = <K extends string, S extends z.ZodRawShape>(kind: K, shape: S) =>
  z.strictObject({ t: z.literal('ctl.event'), kind: z.literal(kind), ts, ...shape });
export const agentControlEventSchema = z.discriminatedUnion('kind', [
  ev('monitors', { monitors: z.array(monitorInfoSchema).max(16), selected: z.array(monitorId).max(16) }),
  ev('capture', {
    monitorId,
    path: z.enum(CAPTURE_PATHS),
    cause: z.enum(CAPTURE_CAUSES),
  }),
  ev('agent_level', {
    level: z.enum(AGENT_CONSENT_LEVELS),
    clipboard: z.boolean(),
    elevation: z.enum(ELEVATION_LEVELS),
  }),
  ev('clipboard', { text: z.string(), truncated: z.boolean() }),
  ev('elevation', {
    opId: z.string().min(1).max(64),
    state: z.enum(['prompt_shown', 'uac_shown', 'handover', 'denied', 'failed']),
    cause: z.string().max(64).optional(),
  }),
  ev('input_blocked', { cause: z.enum(['uipi', 'secure_desktop', 'secure_window']), monitorId: monitorId.optional() }),
  ev('device_attest', {
    gen: z.number().int().min(0).max(65535),
    sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/, 'base64url Ed25519 signature'),
  }),
  ev('keep', { kept: z.boolean() }),
]);

/** Section 3.8: the `control.input` kind an op is aggregated under (null: not a `control.input` op). */
export function agentInputKind(op: string): 'pointer' | 'scroll' | 'key' | 'text' | null {
  switch (op) {
    case 'os.pointer':
      return 'pointer';
    case 'os.scroll':
      return 'scroll';
    case 'os.key':
    case 'os.nav':
      return 'key';
    case 'os.text':
      return 'text';
    default:
      return null;
  }
}

/**
 * Section 3.8 `monitorId` rule for a `control.input` aggregate, both reporters: the op's own `monitorId`
 * (`os.pointer` / `os.scroll`); else the monitor of the most recent pointer / scroll op in the same 10 s window;
 * else the currently viewed monitor (console) or the foreground window's monitor (agent); else 1.
 */
export function controlInputMonitorId(p: {
  op: string;
  args?: unknown;
  lastPointerMonitorId?: number | null;
  viewedMonitorId?: number | null;
}): number {
  const own = (p.args as { monitorId?: unknown } | undefined)?.monitorId;
  if ((p.op === 'os.pointer' || p.op === 'os.scroll') && typeof own === 'number') return own;
  return p.lastPointerMonitorId ?? p.viewedMonitorId ?? 1;
}
