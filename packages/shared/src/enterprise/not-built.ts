/**
 * Phase E section 1.4: the foundation stream lands every shared name with its final signature; a behaviour function
 * owned by a parallel stream throws this until that stream fills it. Nothing in the foundation calls one.
 * Phase F section 1.4 reuses it for the Phase F streams.
 */
export type PhaseEStream = 'sso' | 'tickets' | 'ai' | 'residency' | 'linux';
/** The Phase F streams (docs/specs/phase-f-contracts.md section 1.4). */
export type PhaseFStream = 'fixes' | 'mail' | 'erasure' | 'camera' | 'mobile' | 'linux-p4' | 'wayland' | 'apple';

const PHASE_F_STREAMS: readonly string[] = ['fixes', 'mail', 'erasure', 'camera', 'mobile', 'linux-p4', 'wayland', 'apple'];

export class NotBuiltError extends Error {
  readonly stream: PhaseEStream | PhaseFStream;
  constructor(stream: PhaseEStream | PhaseFStream, name: string) {
    super(`${name} is not built yet (owned by the Phase ${PHASE_F_STREAMS.includes(stream) ? 'F' : 'E'} ${stream} stream)`);
    this.name = 'NotBuiltError';
    this.stream = stream;
  }
}

export function notBuilt(stream: PhaseEStream | PhaseFStream, name: string): never {
  throw new NotBuiltError(stream, name);
}
