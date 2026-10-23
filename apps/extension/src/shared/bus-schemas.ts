/**
 * Schemas of every bus message (section 9.3), one union per receiving context. Every context validates what it
 * receives before acting on it; anything that fails is dropped.
 */
import { z } from 'zod';
import { CONSENT_LEVELS, DATA_CHANNEL_LABELS, LIMITS, MASK_RESTORE_CAUSES, MIRROR_SCOPES, MIRROR_TRANSPORTS } from '@indiansassist/shared';

const level = z.enum(CONSENT_LEVELS);
const tabId = z.number().int().nonnegative().max(0x7fffffff);
const label = z.enum(DATA_CHANNEL_LABELS);
const blobUrl = z.string().max(200).startsWith('blob:chrome-extension://');
const msg = <T extends string, S extends z.ZodRawShape>(t: T, shape: S) => z.object({ to: z.string(), t: z.literal(t), ...shape });

// ---------- ui pages -> worker ----------

export const uiCommandSchema = z.discriminatedUnion('t', [
  msg('ui.connect', { code: z.string().min(1).max(4096), via: z.enum(['clipboard', 'manual']), deskLabel: z.string().max(80).optional() }),
  msg('ui.consent', {
    decision: z.enum(['share', 'decline']),
    level,
    scope: z.enum(MIRROR_SCOPES),
    backstage: z.boolean(),
    tabId: tabId.nullable(),
  }),
  msg('ui.level', { level }),
  msg('ui.backstage', { allowed: z.boolean() }),
  msg('ui.prompt', { id: z.string().min(1).max(40), decision: z.enum(['allow', 'refuse', 'permission_refused']) }),
  msg('ui.stop', { closeBackstage: z.boolean() }),
  msg('ui.revoke', {}),
  msg('ui.pauseTab', { tabId, paused: z.boolean() }),
  msg('ui.hideTab', { tabId }),
  msg('ui.attachTab', { tabId }),
  msg('ui.closeBackstage', { tabId: z.union([tabId, z.literal('all')]) }),
  msg('ui.chat', { text: z.string().min(1).max(LIMITS.maxChatText) }),
  msg('ui.sendFile', { blobUrl, name: z.string().min(1).max(1024), size: z.number().int().nonnegative(), mime: z.string().max(255) }),
  msg('ui.fileDecision', { key: z.string().min(1).max(100), accept: z.boolean() }),
  msg('ui.voice', { muted: z.boolean() }),
  msg('ui.voiceAvailable', { available: z.boolean() }),
  msg('ui.dismissEnded', {}),
  msg('ui.cancel', {}),
  msg('ui.getState', {}),
]);
export type UiCommand = z.infer<typeof uiCommandSchema>;

// ---------- content script -> worker ----------

export const contentToWorkerSchema = z.discriminatedUnion('t', [
  msg('cs.ready', { skippedSelectors: z.array(z.string().max(LIMITS.policySelectorMax)).max(100).optional() }),
  msg('cs.navigated', { url: z.string().max(8192) }),
  msg('cs.pauseClicked', {}),
  msg('cs.resumeClicked', {}),
  msg('cs.stopClicked', {}),
  msg('cs.hideClicked', {}),
  msg('cs.closeBackstageClicked', {}),
  msg('cs.promptAnswer', { id: z.string().min(1).max(40), decision: z.enum(['allow', 'refuse']) }),
  msg('cs.revealEnded', { scope: z.enum(['field', 'tab']), by: z.enum(MASK_RESTORE_CAUSES), durationMs: z.number().int().nonnegative() }),
  msg('cs.barHidden', {}),
  msg('cs.error', { message: z.string().max(500) }),
]);
export type ContentToWorker = z.infer<typeof contentToWorkerSchema>;

// ---------- offscreen -> worker ----------

const webrtcOut = z.discriminatedUnion('t', [
  z.object({ t: z.literal('webrtc.offer'), sdp: z.string().max(60000), restart: z.boolean().optional() }),
  z.object({ t: z.literal('webrtc.answer'), sdp: z.string().max(60000) }),
  z.object({ t: z.literal('webrtc.ice'), candidate: z.record(z.string(), z.unknown()).nullable() }),
]);
export type WebrtcOut = z.infer<typeof webrtcOut>;

export const offscreenToWorkerSchema = z.discriminatedUnion('t', [
  msg('offscreen.ready', {}),
  msg('pc.signal', { msg: webrtcOut }),
  msg('pc.state', { connectionState: z.string().max(20), path: z.enum(['unknown', 'p2p', 'relay']) }),
  msg('dc.open', { label }),
  msg('dc.close', { label }),
  msg('dc.msg', { label, msg: z.unknown() }),
  msg('file.rows', { rows: z.array(z.record(z.string(), z.unknown())).max(200) }),
  msg('file.attest', { action: z.enum(['file.sent', 'file.received']), data: z.record(z.string(), z.unknown()) }),
  msg('mirror.stats', {
    bytes: z.number().nonnegative(),
    batches: z.number().int().nonnegative(),
    kbps: z.number().nonnegative(),
    transport: z.enum(MIRROR_TRANSPORTS),
    tabs: z.record(z.string(), z.object({ bytes: z.number().nonnegative(), batches: z.number().int().nonnegative() })),
  }),
  msg('mirror.tooLarge', { tabId, transport: z.enum(MIRROR_TRANSPORTS) }),
  msg('mirror.transport', { transport: z.enum(MIRROR_TRANSPORTS) }),
  msg('relay.frame', { msg: z.record(z.string(), z.unknown()) }),
  msg('rebuild.needed', {}),
]);
export type OffscreenToWorker = z.infer<typeof offscreenToWorkerSchema>;

// ---------- worker -> offscreen ----------

const iceServer = z.object({ urls: z.union([z.string(), z.array(z.string())]), username: z.string().optional(), credential: z.string().optional() });

export const workerToOffscreenSchema = z.discriminatedUnion('t', [
  msg('pc.create', { iceServers: z.array(iceServer), restart: z.boolean(), relayAllowed: z.boolean() }),
  msg('pc.signal', { msg: z.record(z.string(), z.unknown()) }),
  msg('pc.ice', { iceServers: z.array(iceServer) }),
  msg('pc.close', {}),
  msg('dc.send', { label, msg: z.record(z.string(), z.unknown()) }),
  msg('file.send', { blobUrl, name: z.string().min(1).max(1024), size: z.number().int().nonnegative(), mime: z.string().max(255) }),
  msg('file.decision', { key: z.string().min(1).max(100), accept: z.boolean() }),
  msg('voice.mute', { muted: z.boolean() }),
  msg('mirror.focus', { tabId: tabId.nullable() }),
  msg('mirror.snapshot', { tabId }),
  msg('relay.policy', { allowed: z.boolean() }),
  msg('relay.inbound', { msg: z.record(z.string(), z.unknown()) }),
  msg('ping', {}),
]);
export type WorkerToOffscreen = z.infer<typeof workerToOffscreenSchema>;

// ---------- worker -> content ----------

export const capturePolicySchema = z.object({
  maskSelectors: z.array(z.string().max(LIMITS.policySelectorMax)).max(LIMITS.policySelectorsMax),
  blockSelectors: z.array(z.string().max(LIMITS.policySelectorMax)).max(LIMITS.policySelectorsMax),
  titlePrefix: z.boolean(),
  allowUnmask: z.boolean(),
});
export type CapturePolicy = z.infer<typeof capturePolicySchema>;

export const barStateSchema = z.object({
  technician: z.string().max(200),
  org: z.string().max(200),
  relayed: z.boolean(),
  recording: z.boolean(),
  debuggerAttached: z.boolean(),
  backstage: z.boolean(),
  backstageCount: z.number().int().nonnegative(),
  paused: z.boolean(),
  revealed: z.boolean(),
});
export type BarState = z.infer<typeof barStateSchema>;

export const workerToContentSchema = z.discriminatedUnion('t', [
  msg('cs.start', { policy: capturePolicySchema, bar: barStateSchema, level }),
  msg('cs.stop', {}),
  msg('cs.pause', {}),
  msg('cs.resume', {}),
  msg('cs.level', { level }),
  msg('cs.bar', { bar: barStateSchema.partial() }),
  msg('cs.toast', { text: z.string().max(500), closeBackstageTabId: tabId.nullable() }),
  msg('cs.input', { op: z.string().max(40), args: z.record(z.string(), z.unknown()) }),
  msg('cs.unmask', { scope: z.enum(['field', 'tab']), nodeId: z.number().int().nonnegative().nullable() }),
  msg('cs.unmaskDecision', { granted: z.boolean(), ttlMs: z.number().int().nonnegative() }),
  msg('cs.hide', { by: z.enum(MASK_RESTORE_CAUSES) }),
  msg('cs.prompt', { id: z.string().max(40), text: z.string().max(1200) }),
  msg('cs.promptClear', { id: z.string().max(40) }),
  msg('cs.annot', { msg: z.record(z.string(), z.unknown()) }),
  msg('cs.ping', {}),
]);
export type WorkerToContent = z.infer<typeof workerToContentSchema>;

// ---------- content <-> offscreen Port `ia.mirror` ----------

export const contentToOffscreenSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('cs.events'), events: z.array(z.unknown()).max(100000), snapshot: z.boolean() }),
  z.object({ t: z.literal('cs.meta'), title: z.string().max(2000).nullable(), url: z.string().max(8192).nullable(), favicon: z.null() }),
  z.object({ t: z.literal('cs.fetchCss'), url: z.string().max(8192) }),
  z.object({ t: z.literal('cs.dropped'), reason: z.enum(['overflow']) }),
]);
export type ContentToOffscreen = z.infer<typeof contentToOffscreenSchema>;

export const offscreenToContentSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('oc.focus'), focused: z.boolean() }),
  z.object({ t: z.literal('oc.snapshot') }),
  z.object({ t: z.literal('oc.css'), url: z.string().max(8192), text: z.string().nullable() }),
  z.object({ t: z.literal('oc.stop'), reason: z.enum(['too_large']) }),
]);
export type OffscreenToContent = z.infer<typeof offscreenToContentSchema>;
