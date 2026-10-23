/**
 * Join page <-> extension handshake messages (docs/specs/phase-b-contracts.md sections 2.1 J2, 2.2). The join message
 * carries the code and nothing else: the extension derives the api origin from the sender, never from the page.
 */
import { z } from 'zod';

export const EXT_HANDSHAKE_VERSION = 1;

/** A Chrome extension id: 32 characters a-p. */
export const extensionIdSchema = z.string().regex(/^[a-p]{32}$/, 'expected a Chrome extension id');
const version = z.string().min(1).max(32);

/** `{ t: 'ia.join', v: 1, code }`, strict: any other key or version answers `{ ok: false, error: 'version' }`. */
export const joinHandshakeSchema = z.strictObject({
  t: z.literal('ia.join'),
  v: z.literal(EXT_HANDSHAKE_VERSION),
  code: z.string().min(1).max(4096),
});
export type JoinHandshake = z.infer<typeof joinHandshakeSchema>;

export const JOIN_ERRORS = ['busy', 'bad_code', 'origin', 'version', 'unsupported_tier'] as const;
export type JoinError = (typeof JOIN_ERRORS)[number];

/**
 * The reply: carrier A returns the bare `{ ok, ... }`; carrier B posts it back as
 * `{ source: 'ia-ext', t: 'ia.join.reply', ...reply }`.
 */
export const joinReplySchema = z.union([
  z.strictObject({
    source: z.literal('ia-ext').optional(),
    t: z.literal('ia.join.reply').optional(),
    ok: z.literal(true),
    state: z.enum(['connecting', 'already_connected']),
  }),
  z.strictObject({
    source: z.literal('ia-ext').optional(),
    t: z.literal('ia.join.reply').optional(),
    ok: z.literal(false),
    error: z.enum(JOIN_ERRORS),
  }),
]);
export type JoinReply = z.infer<typeof joinReplySchema>;

export const extPingSchema = z.strictObject({ t: z.literal('ia.ext.ping'), v: z.literal(EXT_HANDSHAKE_VERSION) });
export const extPongSchema = z.strictObject({ t: z.literal('ia.ext.pong'), version, id: extensionIdSchema });
export const extPresentSchema = z.strictObject({
  source: z.literal('ia-ext'),
  t: z.literal('ia.ext.present'),
  version,
  id: extensionIdSchema,
});
export type ExtPing = z.infer<typeof extPingSchema>;
export type ExtPong = z.infer<typeof extPongSchema>;
export type ExtPresent = z.infer<typeof extPresentSchema>;
