/**
 * File transfer over `ia.file`, both directions (contracts section 8.3). One transfer per direction at a
 * time (F1), 256 MiB cap (F2), backpressure on `bufferedAmount` (F3), receiver rules (F4), name
 * sanitising (F5), and the attestation callback after a successful ack (F7). UI state is published as an
 * immutable snapshot through `onChange`.
 */
import {
  LIMITS,
  decodeFileChunk,
  fileExtension,
  isExecutableName,
  type DataChannelMessage,
  type FileDirection,
  type FileEventData,
  type Side,
} from '@indiansassist/shared';
import type { ChannelHub } from './channels';
import { FileAssembler, checkOffer, chunkBlob, makeOffer, sha256HexOf, sniffType } from './fileChunker';

export type TransferStatus =
  | 'hashing'
  | 'offered'
  | 'transferring'
  | 'verifying'
  | 'done'
  | 'rejected'
  | 'cancelled'
  | 'failed';

export type Transfer = {
  key: string;
  direction: FileDirection;
  outgoing: boolean;
  fileId: number;
  name: string;
  extension: string | null;
  executable: boolean;
  mime: string;
  size: number;
  sha256: string | null;
  bytesDone: number;
  status: TransferStatus;
  error?: string;
  sniffed?: string;
  blob?: Blob;
  /** true once the server confirmed the attestation (REST 201 or WS event.ok). */
  reported: boolean;
};

export type AttestFn = (action: 'file.sent' | 'file.received', data: FileEventData) => Promise<boolean>;

const TERMINAL: TransferStatus[] = ['done', 'rejected', 'cancelled', 'failed'];
const HIGH_WATER = 1048576;
const LOW_WATER = 262144;

export class FileTransfer {
  private transfers: Transfer[] = [];
  private nextFileId = 1;
  private assembler: FileAssembler | null = null;
  private incomingOffer: { fileId: number; key: string } | null = null;
  private outgoingFile: { fileId: number; key: string; file: Blob; accepted?: () => void; rejected?: (r: string) => void } | null = null;
  private unsubs: (() => void)[] = [];

  constructor(
    private readonly hub: ChannelHub,
    private readonly side: Side,
    private readonly onChange: (list: Transfer[]) => void,
    private readonly attest: AttestFn,
  ) {
    this.unsubs.push(hub.onMessage((m) => this.onMessage(m)));
    this.unsubs.push(hub.onBinary((d) => this.onChunk(d)));
  }

  private get outDir(): FileDirection {
    return this.side === 'assist' ? 'assist_to_desk' : 'desk_to_assist';
  }

  private get inDir(): FileDirection {
    return this.side === 'assist' ? 'desk_to_assist' : 'assist_to_desk';
  }

  private update(key: string, patch: Partial<Transfer>): void {
    this.transfers = this.transfers.map((t) => (t.key === key ? { ...t, ...patch } : t));
    this.onChange(this.transfers);
  }

  private add(t: Transfer): void {
    this.transfers = [...this.transfers, t];
    this.onChange(this.transfers);
  }

  private find(key: string): Transfer | undefined {
    return this.transfers.find((t) => t.key === key);
  }

  get list(): Transfer[] {
    return this.transfers;
  }

  get busyOutgoing(): boolean {
    return this.outgoingFile !== null;
  }

  /** Sends one file. Rejects locally when another outgoing transfer is running or the file is too large. */
  async send(file: File): Promise<void> {
    if (this.outgoingFile) throw new Error('Another file is still being sent.');
    if (file.size > LIMITS.fileMaxBytes) throw new Error('Files larger than 256 MiB cannot be sent in this version.');
    const fileId = this.nextFileId++;
    const key = `${this.outDir}:${fileId}`;
    const offer = makeOffer(fileId, file.name, file.size, file.type, '0'.repeat(64));
    this.outgoingFile = { fileId, key, file };
    this.add({
      key,
      direction: this.outDir,
      outgoing: true,
      fileId,
      name: offer.name,
      extension: fileExtension(offer.name),
      executable: isExecutableName(offer.name),
      mime: offer.mime,
      size: file.size,
      sha256: null,
      bytesDone: 0,
      status: 'hashing',
      reported: false,
    });
    try {
      const sha256 = await sha256HexOf(await file.arrayBuffer());
      this.update(key, { sha256, status: 'offered' });
      const accepted = new Promise<void>((resolve, reject) => {
        this.outgoingFile!.accepted = resolve;
        this.outgoingFile!.rejected = (r) => reject(new Error(r));
      });
      if (!this.hub.send({ ...offer, sha256, ts: Date.now() })) throw new Error('The file channel is not open.');
      await accepted;
      this.update(key, { status: 'transferring' });
      await this.pump(fileId, key, file);
      if (this.find(key)?.status !== 'transferring') return;
      this.hub.send({ t: 'file.done', fileId, ts: Date.now() });
      this.update(key, { status: 'verifying' });
    } catch (e) {
      const cur = this.find(key);
      if (cur && !TERMINAL.includes(cur.status)) this.update(key, { status: 'failed', error: (e as Error).message });
      this.outgoingFile = null;
    }
  }

  private async pump(fileId: number, key: string, file: Blob): Promise<void> {
    const ch = this.hub.get('ia.file');
    if (!ch) throw new Error('The file channel is not open.');
    ch.bufferedAmountLowThreshold = LOW_WATER;
    let sent = 0;
    let lastReport = 0;
    for await (const frame of chunkBlob(file, fileId)) {
      if (this.find(key)?.status !== 'transferring') return;
      while (ch.bufferedAmount > HIGH_WATER) {
        await new Promise<void>((resolve) => {
          const done = () => {
            ch.removeEventListener('bufferedamountlow', done);
            ch.removeEventListener('close', done);
            resolve();
          };
          ch.addEventListener('bufferedamountlow', done);
          ch.addEventListener('close', done);
        });
        if (ch.readyState !== 'open') throw new Error('The file channel closed.');
      }
      if (!this.hub.sendBinary(frame)) throw new Error('The file channel closed.');
      sent += frame.length - 8;
      if (sent - lastReport > 262144 || sent === file.size) {
        lastReport = sent;
        this.update(key, { bytesDone: sent });
      }
    }
    this.update(key, { bytesDone: sent });
  }

  accept(key: string): void {
    const t = this.find(key);
    if (!t || t.outgoing || t.status !== 'offered' || this.incomingOffer?.key !== key) return;
    this.assembler = new FileAssembler(t.fileId, t.size, Math.ceil(t.size / LIMITS.fileChunkSize));
    this.hub.send({ t: 'file.accept', fileId: t.fileId, ts: Date.now() });
    this.update(key, { status: 'transferring' });
  }

  reject(key: string): void {
    const t = this.find(key);
    if (!t || t.outgoing || t.status !== 'offered') return;
    this.hub.send({ t: 'file.reject', fileId: t.fileId, reason: 'declined', ts: Date.now() });
    this.incomingOffer = null;
    this.update(key, { status: 'rejected' });
  }

  cancel(key: string): void {
    const t = this.find(key);
    if (!t || TERMINAL.includes(t.status)) return;
    this.hub.send({ t: 'file.cancel', fileId: t.fileId, reason: 'aborted', ts: Date.now() });
    this.finishIncomingOrOutgoing(t);
    this.update(key, { status: 'cancelled' });
  }

  private finishIncomingOrOutgoing(t: Transfer): void {
    if (t.outgoing) {
      this.outgoingFile?.rejected?.('cancelled');
      this.outgoingFile = null;
    } else {
      this.assembler?.free();
      this.assembler = null;
      this.incomingOffer = null;
    }
  }

  private onMessage(m: DataChannelMessage): void {
    switch (m.t) {
      case 'file.offer': {
        if (this.incomingOffer) {
          this.hub.send({ t: 'file.reject', fileId: m.fileId, reason: 'busy', ts: Date.now() });
          return;
        }
        const check = checkOffer(m);
        if (!check.ok) {
          this.hub.send({ t: 'file.reject', fileId: m.fileId, reason: check.reason, ts: Date.now() });
          return;
        }
        const key = `${this.inDir}:${m.fileId}:${Date.now()}`;
        this.incomingOffer = { fileId: m.fileId, key };
        this.add({
          key,
          direction: this.inDir,
          outgoing: false,
          fileId: m.fileId,
          name: check.name,
          extension: fileExtension(check.name),
          executable: isExecutableName(check.name),
          mime: m.mime,
          size: m.size,
          sha256: m.sha256,
          bytesDone: 0,
          status: 'offered',
          reported: false,
        });
        return;
      }
      case 'file.accept':
        if (this.outgoingFile?.fileId === m.fileId) this.outgoingFile.accepted?.();
        return;
      case 'file.reject':
        if (this.outgoingFile?.fileId === m.fileId) {
          const key = this.outgoingFile.key;
          this.outgoingFile.rejected?.(m.reason);
          this.outgoingFile = null;
          this.update(key, { status: 'rejected', error: m.reason });
        }
        return;
      case 'file.done':
        void this.onDone(m.fileId);
        return;
      case 'file.ack':
        void this.onAck(m.fileId, m.ok, m.sha256);
        return;
      case 'file.cancel': {
        for (const t of this.transfers) {
          if (t.fileId === m.fileId && !TERMINAL.includes(t.status)) {
            this.finishIncomingOrOutgoing(t);
            this.update(t.key, { status: 'cancelled', error: m.reason ?? 'aborted' });
          }
        }
        return;
      }
      default:
        return;
    }
  }

  private cancelIncoming(fileId: number, reason: 'bad_chunk' | 'overflow' | 'hash_mismatch'): void {
    this.hub.send({ t: 'file.cancel', fileId, reason, ts: Date.now() });
    const key = this.incomingOffer?.fileId === fileId ? this.incomingOffer.key : null;
    this.assembler?.free();
    this.assembler = null;
    this.incomingOffer = null;
    if (key) this.update(key, { status: 'failed', error: reason });
  }

  private onChunk(data: ArrayBuffer): void {
    const chunk = decodeFileChunk(data);
    if (!chunk) return;
    if (!this.assembler || this.assembler.fileId !== chunk.fileId) {
      this.hub.send({ t: 'file.cancel', fileId: chunk.fileId, reason: 'bad_chunk', ts: Date.now() });
      return;
    }
    const err = this.assembler.ingest(chunk);
    if (err) return this.cancelIncoming(chunk.fileId, err);
    const key = this.incomingOffer?.key;
    const received = this.assembler.received;
    if (key && (received === this.assembler.size || chunk.chunkIndex % 16 === 0)) this.update(key, { bytesDone: received });
  }

  private async onDone(fileId: number): Promise<void> {
    const asm = this.assembler;
    const offer = this.incomingOffer;
    if (!asm || !offer || offer.fileId !== fileId) return;
    const t = this.find(offer.key)!;
    const result = asm.finish();
    if (!result.ok) return this.cancelIncoming(fileId, result.reason);
    this.update(offer.key, { status: 'verifying', bytesDone: asm.size });
    const sha256 = await sha256HexOf(result.bytes);
    const ok = sha256 === t.sha256;
    this.hub.send({ t: 'file.ack', fileId, ok, sha256, ts: Date.now() });
    this.assembler = null;
    this.incomingOffer = null;
    if (!ok) {
      this.update(offer.key, { status: 'failed', error: 'hash_mismatch', sha256 });
      return;
    }
    const blob = new Blob([result.bytes as Uint8Array<ArrayBuffer>], { type: t.mime || 'application/octet-stream' });
    this.update(offer.key, { status: 'done', blob, sniffed: sniffType(result.bytes.subarray(0, 16384)), sha256 });
    const reported = await this.attest('file.received', {
      fileId,
      direction: t.direction,
      name: t.name,
      bytes: t.size,
      sha256,
    }).catch(() => false);
    this.update(offer.key, { reported });
  }

  private async onAck(fileId: number, ok: boolean, peerSha: string): Promise<void> {
    const out = this.outgoingFile;
    if (!out || out.fileId !== fileId) return;
    this.outgoingFile = null;
    const t = this.find(out.key)!;
    if (!ok || peerSha !== t.sha256) {
      this.update(out.key, { status: 'failed', error: 'The receiver reported a checksum mismatch.' });
      return;
    }
    this.update(out.key, { status: 'done', bytesDone: t.size });
    const reported = await this.attest('file.sent', {
      fileId,
      direction: t.direction,
      name: t.name,
      bytes: t.size,
      sha256: t.sha256!,
    }).catch(() => false);
    this.update(out.key, { reported });
  }

  /** Stops listening and fails anything in flight (called on teardown). */
  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.assembler?.free();
    this.assembler = null;
    this.outgoingFile?.rejected?.('session ended');
    this.outgoingFile = null;
    this.incomingOffer = null;
    let changed = false;
    this.transfers = this.transfers.map((t) => {
      if (TERMINAL.includes(t.status)) return t;
      changed = true;
      return { ...t, status: 'cancelled', error: 'session ended' };
    });
    if (changed) this.onChange(this.transfers);
  }
}

/** Triggers a browser download of a received file. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
