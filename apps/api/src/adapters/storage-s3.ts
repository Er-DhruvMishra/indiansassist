/**
 * S3 ObjectStorage driver (contracts section 10.1): `@aws-sdk/client-s3` against S3_ENDPOINT (SeaweedFS or managed
 * S3, one bucket per region cluster), presigned GET via `@aws-sdk/s3-request-presigner`. A body of unknown length is
 * spooled to a temp file while hashing so PutObject always gets a ContentLength (avoids adding `@aws-sdk/lib-storage`).
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertValidKey, HashingStream, ObjectNotFoundError, toReadable, type ObjectStorage } from './storage.js';

export type S3StorageOptions = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
};

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

export class S3ObjectStorage implements ObjectStorage {
  readonly driver = 's3' as const;
  readonly bucket: string;
  private readonly client: S3Client;

  constructor(opts: S3StorageOptions, client?: S3Client) {
    this.bucket = opts.bucket;
    this.client =
      client ??
      new S3Client({
        endpoint: opts.endpoint,
        region: opts.region,
        forcePathStyle: opts.forcePathStyle,
        credentials: { accessKeyId: opts.accessKey, secretAccessKey: opts.secretKey },
      });
  }

  async put(
    key: string,
    body: Readable | Uint8Array,
    opts: { contentType: string; contentLength?: number },
  ): Promise<{ bytes: number; sha256: string }> {
    assertValidKey(key);
    const dir = await mkdtemp(join(tmpdir(), 'ia-s3-'));
    const spool = join(dir, 'body');
    try {
      const hasher = new HashingStream();
      await pipeline(toReadable(body), hasher, createWriteStream(spool));
      if (opts.contentLength !== undefined && hasher.bytes !== opts.contentLength)
        throw new Error(`content length mismatch: expected ${opts.contentLength}, got ${hasher.bytes}`);
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: createReadStream(spool),
          ContentLength: hasher.bytes,
          ContentType: opts.contentType,
        }),
      );
      return { bytes: hasher.bytes, sha256: hasher.sha256 };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async get(key: string): Promise<Readable> {
    assertValidKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) throw new ObjectNotFoundError(key);
      return res.Body as Readable;
    } catch (err) {
      if (isNotFound(err)) throw new ObjectNotFoundError(key);
      throw err;
    }
  }

  async head(key: string): Promise<{ bytes: number; contentType: string; lastModified: Date } | null> {
    assertValidKey(key);
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        bytes: Number(res.ContentLength ?? 0),
        contentType: res.ContentType ?? 'application/octet-stream',
        lastModified: res.LastModified ?? new Date(0),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    assertValidKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttlSeconds,
    });
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
