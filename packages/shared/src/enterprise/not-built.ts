/**
 * Phase E section 1.4: the foundation stream lands every shared name with its final signature; a behaviour function
 * owned by a parallel stream throws this until that stream fills it. Nothing in the foundation calls one.
 */
export type PhaseEStream = 'sso' | 'tickets' | 'ai' | 'residency' | 'linux';

export class NotBuiltError extends Error {
  readonly stream: PhaseEStream;
  constructor(stream: PhaseEStream, name: string) {
    super(`${name} is not built yet (owned by the Phase E ${stream} stream)`);
    this.name = 'NotBuiltError';
    this.stream = stream;
  }
}

export function notBuilt(stream: PhaseEStream, name: string): never {
  throw new NotBuiltError(stream, name);
}
