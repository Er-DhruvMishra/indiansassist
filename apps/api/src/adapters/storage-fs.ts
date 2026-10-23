/**
 * Filesystem ObjectStorage driver (dev default, contracts section 10.1). Objects live under STORAGE_FS_DIR; a
 * `<file>.meta.json` sidecar keeps the content type. Writes go to a temp file renamed into place, hashed in flight.
 * `presignGet` returns `${API_ORIGIN}/api/v1/recordings/<id>/file?exp=&sig=` (section 6.10).
 */
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { presignSignature } from '../lib/crypto.js';
import {
  assertValidKey,
  HashingStream,
  ObjectNotFoundError,
  recordingIdOfKey,
  toReadable,
  type ObjectStorage,
} from './storage.js';

export class FsObjectStorage implements ObjectStorage {
  readonly driver = 'fs' as const;
  readonly bucket: string;
  private readonly root: string;

  constructor(private readonly opts: { root: string; apiOrigin: string; presignKey: Buffer }) {
    this.root = resolve(opts.root);
    this.bucket = this.root;
  }

  private pathOf(key: string): string {
    assertValidKey(key);
    const p = resolve(join(this.root, ...key.split('/')));
    if (!p.startsWith(this.root + sep)) throw new Error(`invalid storage key: ${key}`);
    return p;
  }

  async put(
    key: string,
    body: Readable | Uint8Array,
    opts: { contentType: string; contentLength?: number },
  ): Promise<{ bytes: number; sha256: string }> {
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    const hasher = new HashingStream();
    try {
      await pipeline(toReadable(body), hasher, createWriteStream(tmp));
      if (opts.contentLength !== undefined && hasher.bytes !== opts.contentLength)
        throw new Error(`content length mismatch: expected ${opts.contentLength}, got ${hasher.bytes}`);
      await rename(tmp, path);
      await writeFile(`${path}.meta.json`, JSON.stringify({ contentType: opts.contentType }), 'utf8');
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return { bytes: hasher.bytes, sha256: hasher.sha256 };
  }

  async get(key: string): Promise<Readable> {
    const path = this.pathOf(key);
    try {
      await stat(path);
    } catch {
      throw new ObjectNotFoundError(key);
    }
    return createReadStream(path);
  }

  async head(key: string): Promise<{ bytes: number; contentType: string; lastModified: Date } | null> {
    const path = this.pathOf(key);
    try {
      const st = await stat(path);
      let contentType = 'application/octet-stream';
      try {
        const meta = JSON.parse(await readFile(`${path}.meta.json`, 'utf8')) as { contentType?: unknown };
        if (typeof meta.contentType === 'string') contentType = meta.contentType;
      } catch {
        // no sidecar: default content type
      }
      return { bytes: st.size, contentType, lastModified: st.mtime };
    } catch {
      return null;
    }
  }

  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    assertValidKey(key);
    const id = recordingIdOfKey(key);
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = presignSignature(this.opts.presignKey, id, key, exp);
    return `${this.opts.apiOrigin}/api/v1/recordings/${id}/file?exp=${exp}&sig=${sig}`;
  }

  async delete(key: string): Promise<void> {
    const path = this.pathOf(key);
    await rm(path, { force: true });
    await rm(`${path}.meta.json`, { force: true });
  }
}
