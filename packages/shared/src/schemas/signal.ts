/** Signaling unions (discriminated on `t`) and frame parsing helpers (contracts section 7). */
import { z } from 'zod';
import { LIMITS } from '../enums.js';
import { utf8Encode } from '../encoding.js';
import * as m from './signal-messages.js';

/** Every signaling message, each `t` exactly once. */
export const signalMessageSchema = z.discriminatedUnion('t', [
  m.assistHelloSchema,
  m.deskHelloSchema,
  m.deskPollSchema,
  m.deskKnockSchema,
  m.assistAcceptSchema,
  m.assistDenySchema,
  m.deskConsentSchema,
  m.webrtcOfferSchema,
  m.webrtcAnswerSchema,
  m.webrtcIceSchema,
  m.chatMessageSchema,
  m.chatChannelOpenSchema,
  m.sessionStatsSchema,
  m.deskEventSchema,
  m.assistResumeSchema,
  m.sessionEndSchema,
  m.pingSchema,
  m.pongSchema,
  m.assistHelloOkSchema,
  m.deskHelloOkSchema,
  m.pollStatusSchema,
  m.knockOkSchema,
  m.knockHeldSchema,
  m.tokenPresenceSchema,
  m.assistKnockSchema,
  m.knockClosedSchema,
  m.sessionCreatedSchema,
  m.consentOkSchema,
  m.consentChangedSchema,
  m.sessionRecordingSchema,
  m.iceRefreshSchema,
  m.deskReconnectedSchema,
  m.assistReconnectedSchema,
  m.sessionEndedSchema,
  m.eventOkSchema,
  m.signalErrorSchema,
]);
export type SignalMessage = z.infer<typeof signalMessageSchema>;
export type SignalType = SignalMessage['t'];
export type SignalOf<T extends SignalType> = Extract<SignalMessage, { t: T }>;

/** Messages a client (Assist or Desk) may send to the server. */
export const clientSignalMessageSchema = z.discriminatedUnion('t', [
  m.assistHelloSchema,
  m.deskHelloSchema,
  m.deskPollSchema,
  m.deskKnockSchema,
  m.assistAcceptSchema,
  m.assistDenySchema,
  m.deskConsentSchema,
  m.webrtcOfferSchema,
  m.webrtcAnswerSchema,
  m.webrtcIceSchema,
  m.chatMessageSchema,
  m.chatChannelOpenSchema,
  m.sessionStatsSchema,
  m.deskEventSchema,
  m.assistResumeSchema,
  m.sessionEndSchema,
  m.pingSchema,
  m.pongSchema,
]);
export type ClientSignalMessage = z.infer<typeof clientSignalMessageSchema>;

/** Messages the server sends to clients (relayed `webrtc.*` / `chat.message` included). */
export const serverSignalMessageSchema = z.discriminatedUnion('t', [
  m.assistHelloOkSchema,
  m.deskHelloOkSchema,
  m.pollStatusSchema,
  m.knockOkSchema,
  m.knockHeldSchema,
  m.tokenPresenceSchema,
  m.assistKnockSchema,
  m.knockClosedSchema,
  m.sessionCreatedSchema,
  m.consentOkSchema,
  m.consentChangedSchema,
  m.webrtcOfferSchema,
  m.webrtcAnswerSchema,
  m.webrtcIceSchema,
  m.chatMessageSchema,
  m.sessionRecordingSchema,
  m.iceRefreshSchema,
  m.deskReconnectedSchema,
  m.assistReconnectedSchema,
  m.sessionEndedSchema,
  m.eventOkSchema,
  m.signalErrorSchema,
  m.pingSchema,
  m.pongSchema,
]);
export type ServerSignalMessage = z.infer<typeof serverSignalMessageSchema>;

/** Message types the Assist may send; the rest of the client set is Desk-only (plus shared relays). */
export const ASSIST_CLIENT_TYPES = [
  'assist.hello',
  'assist.accept',
  'assist.deny',
  'assist.resume',
  'webrtc.offer',
  'webrtc.answer',
  'webrtc.ice',
  'chat.message',
  'chat.channel_open',
  'session.stats',
  'session.end',
  'ping',
  'pong',
] as const satisfies readonly ClientSignalMessage['t'][];

export const DESK_CLIENT_TYPES = [
  'desk.hello',
  'desk.poll',
  'desk.knock',
  'desk.consent',
  'desk.event',
  'webrtc.offer',
  'webrtc.answer',
  'webrtc.ice',
  'chat.message',
  'session.end',
  'ping',
  'pong',
] as const satisfies readonly ClientSignalMessage['t'][];

export type SignalParseFailure = {
  ok: false;
  code: 'payload_too_large' | 'bad_payload' | 'unknown_type';
  message: string;
  re?: string;
  issues?: z.core.$ZodIssue[];
};
export type SignalParseResult<M> = { ok: true; msg: M } | SignalParseFailure;

type AnyUnion = typeof signalMessageSchema | typeof clientSignalMessageSchema | typeof serverSignalMessageSchema;

function knownTypes(schema: AnyUnion): Set<string> {
  return new Set(schema.options.map((o) => o.shape.t.value as string));
}

const KNOWN = new Map<AnyUnion, Set<string>>();

function parseWith<S extends AnyUnion>(schema: S, frame: unknown): SignalParseResult<z.infer<S>> {
  let value: unknown = frame;
  if (typeof frame === 'string') {
    if (utf8Encode(frame).length > LIMITS.maxWsFrameBytes)
      return { ok: false, code: 'payload_too_large', message: 'frame exceeds 64 KiB' };
    try {
      value = JSON.parse(frame);
    } catch {
      return { ok: false, code: 'bad_payload', message: 'frame is not valid JSON' };
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, code: 'bad_payload', message: 'frame must be a JSON object' };
  const obj = value as Record<string, unknown>;
  const re = typeof obj.id === 'string' ? obj.id : undefined;
  let known = KNOWN.get(schema);
  if (!known) {
    known = knownTypes(schema);
    KNOWN.set(schema, known);
  }
  if (typeof obj.t !== 'string' || !known.has(obj.t)) {
    const fail: SignalParseFailure = { ok: false, code: 'unknown_type', message: `unknown message type` };
    if (re !== undefined) fail.re = re;
    return fail;
  }
  const parsed = schema.safeParse(obj);
  if (!parsed.success) {
    const fail: SignalParseFailure = {
      ok: false,
      code: 'bad_payload',
      message: `invalid ${obj.t} payload`,
      issues: parsed.error.issues,
    };
    if (re !== undefined) fail.re = re;
    return fail;
  }
  return { ok: true, msg: parsed.data as z.infer<S> };
}

/** Parses any signaling frame (string or already-decoded object). */
export function parseSignalMessage(frame: unknown): SignalParseResult<SignalMessage> {
  return parseWith(signalMessageSchema, frame);
}

/** Server side: parses a frame received from a client; server-only types are `unknown_type`. */
export function parseClientSignal(frame: unknown): SignalParseResult<ClientSignalMessage> {
  return parseWith(clientSignalMessageSchema, frame);
}

/** Client side: parses a frame received from the server. */
export function parseServerSignal(frame: unknown): SignalParseResult<ServerSignalMessage> {
  return parseWith(serverSignalMessageSchema, frame);
}

/** Serialises a message after validating it against the full union (throws ZodError on a bad message). */
export function encodeSignal(message: SignalMessage): string {
  return JSON.stringify(signalMessageSchema.parse(message));
}
