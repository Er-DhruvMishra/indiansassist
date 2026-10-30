/**
 * Browser control protocol on `ia.control` (and `control.relay`), docs/specs/phase-b-contracts.md sections 4.5, 5:
 * the closed op list, strict per-op argument schemas, responses, events, `minLevelFor` and the shared `TabInfo` /
 * `GroupInfo` / `WindowInfo` shapes.
 */
import { z } from 'zod';
import { sha256Hex } from '../canonical.js';
import {
  BACKSTAGE_ACTIONS,
  CONSENT_LEVELS,
  INPUT_MODES,
  LIMITS,
  MASK_SCOPES,
  MIRROR_SCOPES,
  type ConsentLevel,
} from '../enums.js';
import { isMirrorableUrl } from './deny-list.js';

const ts = z.number().int().nonnegative();
const tabId = z.number().int().nonnegative().max(0x7fffffff);
const windowId = z.number().int().nonnegative().max(0x7fffffff);
const groupId = z.number().int().min(-1).max(0x7fffffff);
const index = z.number().int().min(-1).max(10000);
const unit = z.number().min(0).max(1);
const nodeId = z.number().int().nonnegative().max(0x7fffffff);
const tabIds = z.array(tabId).min(1).max(LIMITS.tabsCloseMax);
const reason = z.string().min(1).max(LIMITS.reasonMax);
const delta = z.number().finite().min(-100000).max(100000);
/** `http(s)` only; anything else answers `bad_args` (section 5.2). */
export const navigableUrlSchema = z.string().max(8192).url().refine(isMirrorableUrl, 'only http: and https: URLs');

export const TAB_GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const;
const groupColor = z.enum(TAB_GROUP_COLORS);

export const modifiersSchema = z.strictObject({ alt: z.boolean(), ctrl: z.boolean(), meta: z.boolean(), shift: z.boolean() });
export type Modifiers = z.infer<typeof modifiersSchema>;

export const TAB_MIRROR_STATES = ['yes', 'paused', 'denied', 'too_large', 'not_in_scope', 'unsupported'] as const;

export const tabInfoSchema = z
  .strictObject({
    tabId,
    windowId,
    index: z.number().int().nonnegative(),
    title: z.string().max(2000).nullable(),
    url: z.string().max(8192).nullable(),
    favicon: z.string().startsWith('data:image/').max(11000).nullable(),
    active: z.boolean(),
    pinned: z.boolean(),
    muted: z.boolean(),
    audible: z.boolean(),
    groupId,
    status: z.enum(['loading', 'complete']),
    mirrored: z.enum(TAB_MIRROR_STATES),
    backstage: z.boolean(),
    createdByAssist: z.boolean(),
    revealed: z.enum(['none', 'field', 'tab']),
    discarded: z.boolean(),
    error: z.literal('inject_failed').optional(),
  })
  .refine((t) => (t.mirrored !== 'denied' && t.mirrored !== 'not_in_scope') || (t.title === null && t.url === null && t.favicon === null), {
    message: 'denied and not_in_scope tabs carry no title, url or favicon',
  });
export type TabInfo = z.infer<typeof tabInfoSchema>;

export const groupInfoSchema = z.strictObject({
  groupId: z.number().int().nonnegative(),
  windowId,
  title: z.string().max(200),
  color: groupColor,
  collapsed: z.boolean(),
  tabIds: z.array(tabId).max(500),
});
export type GroupInfo = z.infer<typeof groupInfoSchema>;

export const windowInfoSchema = z.strictObject({
  windowId,
  focused: z.boolean(),
  state: z.enum(['normal', 'minimized', 'maximized', 'fullscreen', 'locked-fullscreen']),
  type: z.enum(['normal', 'popup', 'panel', 'app', 'devtools']),
  tabCount: z.number().int().nonnegative(),
  incognito: z.literal(false),
});
export type WindowInfo = z.infer<typeof windowInfoSchema>;

const empty = z.strictObject({});

/** Strict argument schema of every op (section 5.3). */
export const CONTROL_ARGS = {
  'tabs.list': empty,
  'tabs.query': z.strictObject({
    windowId: windowId.optional(),
    groupId: groupId.optional(),
    active: z.boolean().optional(),
    pinned: z.boolean().optional(),
    audible: z.boolean().optional(),
    urlHost: z.string().min(1).max(LIMITS.policyHostPatternMax).optional(),
  }),
  'tabs.activate': z.strictObject({ tabId }),
  'tabs.create': z.strictObject({ url: navigableUrlSchema.optional(), windowId: windowId.optional(), index: index.optional(), pinned: z.boolean().optional() }),
  'tabs.close': z.strictObject({ tabIds }),
  'tabs.reload': z.strictObject({ tabId, bypassCache: z.boolean().optional() }),
  'tabs.navigate': z.strictObject({ tabId, url: navigableUrlSchema }),
  'tabs.pin': z.strictObject({ tabId, pinned: z.boolean() }),
  'tabs.mute': z.strictObject({ tabId, muted: z.boolean() }),
  'tabs.move': z.strictObject({ tabIds, index, windowId: windowId.optional() }),
  'tabGroups.list': z.strictObject({ windowId: windowId.optional() }),
  'tabGroups.create': z.strictObject({ tabIds, title: z.string().max(200).optional(), color: groupColor.optional() }),
  'tabGroups.update': z.strictObject({
    groupId: z.number().int().nonnegative(),
    title: z.string().max(200).optional(),
    color: groupColor.optional(),
    collapsed: z.boolean().optional(),
  }),
  'tabGroups.move': z.strictObject({ groupId: z.number().int().nonnegative(), index, windowId: windowId.optional() }),
  'tabGroups.collapse': z.strictObject({ groupId: z.number().int().nonnegative(), collapsed: z.boolean() }),
  'tabGroups.ungroup': z.strictObject({ tabIds }),
  'windows.list': empty,
  'mirror.focus': z.strictObject({ tabId }),
  'mirror.snapshot': z.strictObject({ tabId }),
  'mirror.attach': z.strictObject({ tabId, reason }),
  'input.pointer': z
    .strictObject({
      tabId,
      kind: z.enum(['move', 'down', 'up', 'click', 'dblclick', 'contextmenu', 'wheel']),
      nodeId: nodeId.nullable(),
      nx: unit.optional(),
      ny: unit.optional(),
      vx: unit,
      vy: unit,
      button: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
      modifiers: modifiersSchema,
      deltaX: delta.optional(),
      deltaY: delta.optional(),
    })
    .refine((a) => a.nodeId === null || (a.nx !== undefined && a.ny !== undefined), {
      message: 'nx and ny are required when nodeId is a number',
      path: ['nx'],
    }),
  'input.key': z.strictObject({
    tabId,
    kind: z.enum(['down', 'up', 'press']),
    key: z.string().min(1).max(64),
    code: z.string().max(64),
    modifiers: modifiersSchema,
    text: z.string().max(1000).optional(),
  }),
  'input.scroll': z.strictObject({ tabId, nodeId: nodeId.nullable(), dx: delta, dy: delta }),
  'input.fill': z.strictObject({ tabId, nodeId, value: z.string().max(LIMITS.fillValueMax), commit: z.boolean() }),
  'input.mode': z.strictObject({ tabId, mode: z.enum(INPUT_MODES) }),
  'level.request': z
    .strictObject({ level: z.enum(CONSENT_LEVELS), reason: reason.optional() })
    .refine((a) => (a.level !== 'in_page' && a.level !== 'deep_control') || a.reason !== undefined, {
      message: 'reason is required for in_page and deep_control',
      path: ['reason'],
    }),
  'mask.request': z
    .strictObject({ tabId, scope: z.enum(MASK_SCOPES), nodeId: nodeId.optional(), reason })
    .refine((a) => a.scope !== 'field' || a.nodeId !== undefined, { message: 'nodeId is required for field scope', path: ['nodeId'] }),
  'backstage.enter': z.strictObject({ url: navigableUrlSchema, windowId: windowId.optional() }),
  'backstage.exit': z.strictObject({ tabId, action: z.enum(BACKSTAGE_ACTIONS) }),
} as const;

export type ControlOp = keyof typeof CONTROL_ARGS;
export const CONTROL_OPS = Object.keys(CONTROL_ARGS) as ControlOp[];

export function isControlOp(x: unknown): x is ControlOp {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(CONTROL_ARGS, x);
}

/** Ops whose audit column is `tab.action` (`TabActionKind`, section 5.3). */
export const TAB_ACTION_KINDS = [
  'tabs.activate',
  'tabs.create',
  'tabs.close',
  'tabs.reload',
  'tabs.navigate',
  'tabs.pin',
  'tabs.mute',
  'tabs.move',
  'tabGroups.create',
  'tabGroups.update',
  'tabGroups.move',
  'tabGroups.collapse',
  'tabGroups.ungroup',
] as const satisfies readonly ControlOp[];
export type TabActionKind = (typeof TAB_ACTION_KINDS)[number];

export const CONTROL_ERROR_CODES = [
  'not_allowed',
  'denied_url',
  'no_such_tab',
  'tab_paused',
  'not_supported',
  'not_in_scope',
  'debugger_unavailable',
  'refused',
  'timeout',
  'rate_limited',
  'bad_args',
  'internal',
  // Phase C section 5.1 additions (native Desk).
  'elevation_required',
  'no_such_monitor',
  'blocked_uipi',
  'secure_desktop',
  'secure_window',
  'clipboard_off',
  'hash_mismatch',
  'busy',
] as const;
export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number];

const MIN_LEVEL: Record<ControlOp, ConsentLevel> = {
  'tabs.list': 'view',
  'tabs.query': 'view',
  'tabs.activate': 'tab_control',
  'tabs.create': 'tab_control',
  'tabs.close': 'tab_control',
  'tabs.reload': 'tab_control',
  'tabs.navigate': 'tab_control',
  'tabs.pin': 'tab_control',
  'tabs.mute': 'tab_control',
  'tabs.move': 'tab_control',
  'tabGroups.list': 'view',
  'tabGroups.create': 'tab_control',
  'tabGroups.update': 'tab_control',
  'tabGroups.move': 'tab_control',
  'tabGroups.collapse': 'tab_control',
  'tabGroups.ungroup': 'tab_control',
  'windows.list': 'view',
  'mirror.focus': 'view',
  'mirror.snapshot': 'view',
  'mirror.attach': 'view',
  'input.pointer': 'in_page',
  'input.key': 'in_page',
  'input.scroll': 'in_page',
  'input.fill': 'in_page',
  'input.mode': 'in_page',
  'level.request': 'view',
  'mask.request': 'view',
  'backstage.enter': 'tab_control',
  'backstage.exit': 'tab_control',
};

/**
 * Minimum consent level of an op (section 5.3). `input.mode` needs `deep_control` for `mode: 'debugger'`, which
 * only the request knows: pass `args` to get the exact level.
 */
export function minLevelFor(op: ControlOp, args?: unknown): ConsentLevel {
  if (op === 'input.mode' && (args as { mode?: unknown } | undefined)?.mode === 'debugger') return 'deep_control';
  return MIN_LEVEL[op];
}

/** `sha256Hex(sessionId + ':' + ctl.req.id).slice(0, 16)`: the chain correlation id of one request (section 3.7). */
export function opIdFor(sessionId: string, reqId: string): string {
  return sha256Hex(`${sessionId}:${reqId}`).slice(0, 16);
}

const reqId = z.string().min(1).max(40);

function req<O extends ControlOp>(op: O) {
  return z.strictObject({ t: z.literal('ctl.req'), id: reqId, op: z.literal(op), args: CONTROL_ARGS[op], ts });
}

const REQUESTS = CONTROL_OPS.map((op) => req(op)) as unknown as [ReturnType<typeof req<'tabs.list'>>, ...ReturnType<typeof req<ControlOp>>[]];

/** `ctl.req`, discriminated on `op`, strict args. */
export const controlRequestSchema = z.discriminatedUnion('op', REQUESTS);
export type ControlRequest = { [O in ControlOp]: { t: 'ctl.req'; id: string; op: O; args: z.infer<(typeof CONTROL_ARGS)[O]>; ts: number } }[ControlOp];

export const controlResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ t: z.literal('ctl.res'), id: reqId, ok: z.literal(true), result: z.record(z.string(), z.unknown()), ts }),
  z.strictObject({
    t: z.literal('ctl.res'),
    id: reqId,
    ok: z.literal(false),
    error: z.strictObject({ code: z.enum(CONTROL_ERROR_CODES), message: z.string().max(200) }),
    ts,
  }),
]);
export type ControlResponse = z.infer<typeof controlResponseSchema>;

const ev = <K extends string, S extends z.ZodRawShape>(kind: K, shape: S) =>
  z.strictObject({ t: z.literal('ctl.event'), kind: z.literal(kind), ts, ...shape });

export const controlEventSchema = z.discriminatedUnion('kind', [
  ev('level', { level: z.enum(CONSENT_LEVELS), scope: z.enum(MIRROR_SCOPES), backstage: z.boolean() }),
  ev('debugger', {
    tabId,
    attached: z.boolean(),
    cause: z.enum(['request', 'level', 'navigation', 'pause', 'user', 'close']).optional(),
  }),
  ev('paused', { tabId, paused: z.boolean() }),
  ev('backstage', { tabId, state: z.enum(['opened', 'closed', 'front']) }),
  ev('prompt', { id: reqId, promptKind: z.enum(['level', 'mask', 'attach']), state: z.enum(['shown', 'answered']), opId: z.string().regex(/^[0-9a-f]{16}$/) }),
]);
export type ControlEvent = z.infer<typeof controlEventSchema>;

/** Every message on `ia.control` / in `control.relay.msg`. */
export const controlMessageSchema = z.union([controlRequestSchema, controlResponseSchema, controlEventSchema]);
export type ControlMessage = z.infer<typeof controlMessageSchema>;
