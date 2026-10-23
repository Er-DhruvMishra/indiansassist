/**
 * The postMessage protocol between the console and the sandboxed replayer frame (Phase B 10.2, web-local).
 * Parent -> frame: `rp.*` commands with sanitised rrweb events. Frame -> parent: `rp.ready`, captured input,
 * mask counts and acknowledgements, each validated with `replayerMessageSchema` before use.
 */
import { z } from 'zod';

const tabId = z.number().int().nonnegative().max(0x7fffffff);
const unit = z.number().min(0).max(1);
const nodeId = z.number().int().nonnegative().max(0x7fffffff).nullable();
const delta = z.number().finite().min(-100000).max(100000);
export const rpModifiersSchema = z.strictObject({ alt: z.boolean(), ctrl: z.boolean(), meta: z.boolean(), shift: z.boolean() });
export type RpModifiers = z.infer<typeof rpModifiersSchema>;

export const POINTER_KINDS = ['move', 'down', 'up', 'click', 'dblclick', 'contextmenu'] as const;

/** Frame -> parent. */
export const replayerMessageSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('rp.ready') }),
  z.strictObject({ t: z.literal('rp.applied'), tabId, kind: z.enum(['snapshot', 'events']) }),
  z.strictObject({
    t: z.literal('rp.pointer'),
    tabId,
    kind: z.enum(POINTER_KINDS),
    nodeId,
    nx: unit.optional(),
    ny: unit.optional(),
    vx: unit,
    vy: unit,
    button: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    modifiers: rpModifiersSchema,
    /** True when the node's text is a mask (`*` only): a reveal target. */
    masked: z.boolean().optional(),
  }),
  z.strictObject({
    t: z.literal('rp.wheel'),
    tabId,
    nodeId,
    vx: unit,
    vy: unit,
    deltaX: delta,
    deltaY: delta,
  }),
  z.strictObject({
    t: z.literal('rp.key'),
    tabId,
    kind: z.enum(['down', 'up']),
    key: z.string().min(1).max(64),
    code: z.string().max(64),
    modifiers: rpModifiersSchema,
  }),
  z.strictObject({ t: z.literal('rp.maskStats'), tabId, masked: z.number().int().nonnegative(), revealed: z.number().int().nonnegative() }),
  z.strictObject({ t: z.literal('rp.error'), tabId: tabId.optional(), message: z.string().max(500) }),
]);
export type ReplayerMessage = z.infer<typeof replayerMessageSchema>;
export type RpPointer = Extract<ReplayerMessage, { t: 'rp.pointer' }>;
export type RpKey = Extract<ReplayerMessage, { t: 'rp.key' }>;
export type RpWheel = Extract<ReplayerMessage, { t: 'rp.wheel' }>;

/** What a click or key in the frame is used for: nothing, input forwarding, or picking a field to reveal. */
export const ARM_MODES = ['off', 'input', 'reveal'] as const;
export type ArmMode = (typeof ARM_MODES)[number];

/** Parent -> frame (the frame validates these with `parentMessageSchema` and sanitises events again). */
export const parentMessageSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('rp.snapshot'), tabId, events: z.array(z.unknown()).max(100000) }),
  z.strictObject({ t: z.literal('rp.events'), tabId, events: z.array(z.unknown()).max(100000) }),
  z.strictObject({ t: z.literal('rp.reset'), tabId: tabId.optional() }),
  z.strictObject({ t: z.literal('rp.focus'), tabId: tabId.nullable() }),
  z.strictObject({ t: z.literal('rp.setSize'), width: z.number().nonnegative().max(100000), height: z.number().nonnegative().max(100000) }),
  z.strictObject({ t: z.literal('rp.arm'), mode: z.enum(ARM_MODES) }),
]);
export type ParentMessage = z.infer<typeof parentMessageSchema>;

/** Replayers kept alive at once (Phase B 10.2: the 4 most recently focused tabs). */
export const MAX_LIVE_REPLAYERS = 4;
