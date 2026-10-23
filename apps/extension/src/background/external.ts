/**
 * The join handshake receiver (section 2.2) for both carriers: A = `runtime.onMessageExternal` from the join page,
 * B = the bridge content script forwarding a page `postMessage`. Either way the origin comes from the browser
 * (`sender.origin`, else `sender.url`), never from the message, and must be one of the compiled `REGION_ORIGINS`
 * exactly. The message itself must be strictly `{ t: 'ia.join', v: 1, code }`; anything else answers `version`.
 */
import { EXT_HANDSHAKE_VERSION, extPingSchema, joinHandshakeSchema, type JoinReply } from '@indiansassist/shared';
import { EXTENSION_VERSION, isRegionOrigin } from '../shared/constants';

export type ExternalDeps = {
  extensionId: string;
  /** Starts the join for a code on a compiled origin; answers busy / bad_code / unsupported_tier / connecting. */
  join: (code: string, apiOrigin: string) => Promise<JoinReply>;
  /** An origin refusal (logged to `ia.diagnostics`). */
  onOriginRefused: (origin: string | null) => void;
};

/** The full sender origin (scheme, host, port) as the browser reports it, or null. */
export function senderOrigin(sender: { origin?: string; url?: string } | undefined): string | null {
  if (sender?.origin && sender.origin !== 'null') return sender.origin;
  if (sender?.url) {
    try {
      const o = new URL(sender.url).origin;
      return o === 'null' ? null : o;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Answers one handshake message. Returns undefined for messages that are neither a ping nor a join attempt
 * (those get no answer at all).
 */
export async function handleHandshake(msg: unknown, origin: string | null, deps: ExternalDeps): Promise<unknown> {
  if (!msg || typeof msg !== 'object') return undefined;
  const t = (msg as { t?: unknown }).t;
  if (t !== 'ia.ext.ping' && t !== 'ia.join') return undefined;
  if (!isRegionOrigin(origin)) {
    deps.onOriginRefused(origin);
    return { ok: false, error: 'origin' } satisfies JoinReply;
  }
  if (t === 'ia.ext.ping') {
    if (!extPingSchema.safeParse(msg).success) return undefined;
    return { t: 'ia.ext.pong', version: EXTENSION_VERSION, id: deps.extensionId };
  }
  const parsed = joinHandshakeSchema.safeParse(msg);
  if (!parsed.success || parsed.data.v !== EXT_HANDSHAKE_VERSION) return { ok: false, error: 'version' } satisfies JoinReply;
  return deps.join(parsed.data.code, origin);
}
