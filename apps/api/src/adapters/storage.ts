/** ObjectStorage adapter (contracts section 10.1) plus the hashing helpers both drivers share. */
import { createHash } from 'node:crypto';
import { Readable, Transform, type TransformCallback } from 'node:stream';

export interface ObjectStorage {
  readonly driver: 'fs' | 's3';
  /** Bucket name (s3) or root directory (fs), for the residency report. */
  readonly bucket: string;
  put(
    key: string,
    body: Readable | Uint8Array,
    opts: { contentType: string; contentLength?: number },
  ): Promise<{ bytes: number; sha256: string }>;
  /** Throws ObjectNotFoundError. */
  get(key: string): Promise<Readable>;
  head(key: string): Promise<{ bytes: number; contentType: string; lastModified: Date } | null>;
  presignGet(key: string, ttlSeconds: number): Promise<string>;
  /** Idempotent. */
  delete(key: string): Promise<void>;
}

export class ObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`object not found: ${key}`);
    this.name = 'ObjectNotFoundError';
  }
}

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** Keys are relative, slash separated, with no `..` segment and no absolute or drive prefix. */
export function assertValidKey(key: string): void {
  if (key.length > 1024 || !KEY_RE.test(key) || key.split('/').some((s) => s === '..' || s === '.'))
    throw new Error(`invalid storage key: ${key}`);
}

/** A pass-through stream that counts bytes and computes sha256 of everything that flows through it. */
export class HashingStream extends Transform {
  private readonly hash = createHash('sha256');
  bytes = 0;
  private digestHex: string | null = null;
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    cb(null, chunk);
  }
  override _flush(cb: TransformCallback): void {
    this.digestHex = this.hash.digest('hex');
    cb();
  }
  get sha256(): string {
    if (this.digestHex === null) throw new Error('stream not finished');
    return this.digestHex;
  }
}

export function toReadable(body: Readable | Uint8Array): Readable {
  return body instanceof Uint8Array ? Readable.from([Buffer.from(body)]) : body;
}

/** sha256 hex and byte count of a stream (recording verify). */
export async function hashStream(stream: Readable): Promise<{ sha256: string; bytes: number }> {
  const h = createHash('sha256');
  let bytes = 0;
  for await (const chunk of stream) {
    const b = chunk as Buffer;
    h.update(b);
    bytes += b.length;
  }
  return { sha256: h.digest('hex'), bytes };
}

/** The recording id in a `<region>/<orgId>/<sessionId>/<recordingId>.webm[.part<n>]` key. */
export function recordingIdOfKey(key: string): string {
  const base = key.split('/').pop() ?? key;
  return base.split('.')[0] ?? base;
}
