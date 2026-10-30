/**
 * Phase C section 6.1 F2 (A F3 amended for P3): the console sender of a P3 session streams. The sha256 is computed
 * incrementally (`createSha256Hasher`) over `file.stream()` (or `Blob.slice` windows when streams are unavailable)
 * before the offer, so a 2 GiB file never sits in one `ArrayBuffer`; chunks are then read with `Blob.slice` under
 * the `bufferedAmount` back-pressure of `FileTransfer.pump`.
 */
import { LIMITS, createSha256Hasher, isExecutableName, isPassiveRiskName } from '@indiansassist/shared';
import { blobBytes } from './fileChunker';
import type { FileTransferOptions } from './fileTransfer';

/** Read window of the slice fallback (1 MiB). */
export const HASH_WINDOW = 1024 * 1024;

type StreamingBlob = Blob & { stream?: () => ReadableStream<Uint8Array> };

/** Incremental sha256 of a Blob; `onProgress` gets the bytes hashed so far. */
export async function streamSha256(blob: Blob, onProgress?: (done: number) => void): Promise<string> {
  const h = createSha256Hasher();
  let done = 0;
  const s = blob as StreamingBlob;
  if (typeof s.stream === 'function') {
    const reader = s.stream().getReader();
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      if (value) {
        h.update(value);
        done += value.length;
        onProgress?.(done);
      }
    }
    return h.digestHex();
  }
  for (let off = 0; off < blob.size; off += HASH_WINDOW) {
    const part = await blobBytes(blob.slice(off, Math.min(blob.size, off + HASH_WINDOW)));
    h.update(part);
    done += part.length;
    onProgress?.(done);
  }
  return h.digestHex();
}

/** Why the console greys a file for a native Desk (section 6.1 F4), or null when it may be offered. */
export function refuseForNativeDesk(name: string): string | null {
  if (isPassiveRiskName(name)) return 'The Desk refuses this file type: it can make Windows contact another computer just by showing the folder.';
  return null;
}

/** Whether the file needs the executable warning on the Desk (shown in the console as a hint). */
export function warnsOnDesk(name: string): boolean {
  return isExecutableName(name);
}

/** FileTransfer options of a P3 console: 2 GiB, streaming hash, passive-risk refusal. */
export const NATIVE_SEND_OPTIONS: FileTransferOptions = {
  maxBytes: LIMITS.fileMaxBytesNative,
  hashBlob: (b) => streamSha256(b),
  refuse: refuseForNativeDesk,
};
