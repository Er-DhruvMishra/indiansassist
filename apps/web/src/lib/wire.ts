/** Signaling send / receive helpers. */
import type { ClientSignalMessage } from '@indiansassist/shared';

/**
 * The shared zod-inferred types of messages whose payload redefines the envelope's optional `ts` come out
 * unusable (`ts: undefined`); the runtime check in `encodeSignal` still validates the frame.
 */
export function asClient(m: Record<string, unknown> & { t: string }): ClientSignalMessage {
  return m as unknown as ClientSignalMessage;
}
