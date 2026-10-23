/**
 * File transfer over `ia.file` in the offscreen document (Phase A 8.3, section 7 "Files"): the side panel hands
 * a `blob:` URL of the chosen file, this document fetches it and runs the sender; received files are assembled
 * here and handed to the panel as a `blob:` URL after the Desk accepted the offer. One transfer per direction.
 */
import { LIMITS, decodeFileChunk, isExecutableName, parseDataChannelMessage } from '@indiansassist/shared';
import type { FileRow } from '../shared/ui-state';
import { FileAssembler, checkOffer, chunkBlob, makeOffer, sha256HexOf, sniffType } from '../shared/file-transfer';

const TERMINAL = new Set<FileRow['status']>(['done', 'rejected', 'cancelled', 'failed']);

export type FileEngineDeps = {
  channel: () => RTCDataChannel | null;
  onRows: (rows: FileRow[]) => void;
  attest: (action: 'file.sent' | 'file.received', data: Record<string, unknown>) => void;
};

export class FileEngine {
  private rows: FileRow[] = [];
  private nextId = 1;
  private out: { fileId: number; key: string; sha256: string; accepted?: () => void; rejected?: (r: string) => void } | null = null;
  private incoming: { fileId: number; key: string; asm: FileAssembler | null; sha256: string } | null = null;

  constructor(private readonly d: FileEngineDeps) {}

  private update(key: string, patch: Partial<FileRow>): void {
    this.rows = this.rows.map((r) => (r.key === key ? { ...r, ...patch } : r));
    this.d.onRows(this.rows);
  }

  private add(row: FileRow): void {
    this.rows = [...this.rows, row].slice(-50);
    this.d.onRows(this.rows);
  }

  private find(key: string): FileRow | undefined {
    return this.rows.find((r) => r.key === key);
  }

  private sendJson(msg: Record<string, unknown>): boolean {
    const ch = this.d.channel();
    if (!ch || ch.readyState !== 'open') return false;
    ch.send(JSON.stringify(msg));
    return true;
  }

  async send(blobUrl: string, name: string, mime: string): Promise<void> {
    if (this.out) throw new Error('Another file is still being sent.');
    const blob = await (await fetch(blobUrl)).blob();
    URL.revokeObjectURL(blobUrl);
    if (blob.size > LIMITS.fileMaxBytes) throw new Error('Files larger than 256 MiB cannot be sent.');
    const fileId = this.nextId++;
    const key = `out:${fileId}`;
    const sha256 = await sha256HexOf(new Uint8Array(await blob.arrayBuffer()));
    const offer = makeOffer(fileId, name, blob.size, mime, sha256);
    this.out = { fileId, key, sha256 };
    this.add({ key, outgoing: true, fileId, name: offer.name, size: blob.size, mime: offer.mime, status: 'offered', bytesDone: 0, executable: isExecutableName(offer.name) });
    try {
      const accepted = new Promise<void>((resolve, reject) => {
        this.out!.accepted = resolve;
        this.out!.rejected = (r) => reject(new Error(r));
      });
      if (!this.sendJson(offer)) throw new Error('The file channel is not open.');
      await accepted;
      this.update(key, { status: 'transferring' });
      const ch = this.d.channel();
      if (!ch) throw new Error('The file channel closed.');
      ch.bufferedAmountLowThreshold = 262144;
      let sent = 0;
      for await (const frame of chunkBlob(blob, fileId)) {
        if (this.find(key)?.status !== 'transferring') return;
        while (ch.bufferedAmount > 1048576) await new Promise((r) => ch.addEventListener('bufferedamountlow', r, { once: true }));
        if (ch.readyState !== 'open') throw new Error('The file channel closed.');
        ch.send(frame as Uint8Array<ArrayBuffer>);
        sent += frame.length - 8;
        if (sent % (LIMITS.fileChunkSize * 32) === 0 || sent === blob.size) this.update(key, { bytesDone: sent });
      }
      this.sendJson({ t: 'file.done', fileId, ts: Date.now() });
      this.update(key, { status: 'verifying', bytesDone: blob.size });
    } catch (e) {
      const cur = this.find(key);
      if (cur && !TERMINAL.has(cur.status)) this.update(key, { status: 'failed', error: (e as Error).message });
      this.out = null;
    }
  }

  decide(key: string, accept: boolean): void {
    const inc = this.incoming;
    const row = this.find(key);
    if (!inc || inc.key !== key || !row || row.status !== 'offered') return;
    if (!accept) {
      this.sendJson({ t: 'file.reject', fileId: inc.fileId, reason: 'declined', ts: Date.now() });
      this.incoming = null;
      return this.update(key, { status: 'rejected' });
    }
    inc.asm = new FileAssembler(inc.fileId, row.size, Math.ceil(row.size / LIMITS.fileChunkSize));
    this.sendJson({ t: 'file.accept', fileId: inc.fileId, ts: Date.now() });
    this.update(key, { status: 'transferring' });
  }

  onText(text: string): void {
    const p = parseDataChannelMessage('ia.file', text);
    if (!p.ok) return;
    const m = p.msg;
    if (m.t === 'file.offer') {
      if (this.incoming) return void this.sendJson({ t: 'file.reject', fileId: m.fileId, reason: 'busy', ts: Date.now() });
      const check = checkOffer(m);
      if (!check.ok) return void this.sendJson({ t: 'file.reject', fileId: m.fileId, reason: check.reason, ts: Date.now() });
      const key = `in:${m.fileId}:${Date.now()}`;
      this.incoming = { fileId: m.fileId, key, asm: null, sha256: m.sha256 };
      this.add({ key, outgoing: false, fileId: m.fileId, name: check.name, size: m.size, mime: m.mime, status: 'offered', bytesDone: 0, executable: isExecutableName(check.name) });
    } else if (m.t === 'file.accept' && this.out?.fileId === m.fileId) this.out.accepted?.();
    else if (m.t === 'file.reject' && this.out?.fileId === m.fileId) {
      const key = this.out.key;
      this.out.rejected?.(m.reason);
      this.out = null;
      this.update(key, { status: 'rejected', error: m.reason });
    } else if (m.t === 'file.done') void this.onDone(m.fileId);
    else if (m.t === 'file.ack') this.onAck(m.fileId, m.ok, m.sha256);
    else if (m.t === 'file.cancel') {
      for (const r of this.rows) if (r.fileId === m.fileId && !TERMINAL.has(r.status)) this.update(r.key, { status: 'cancelled', error: m.reason ?? 'aborted' });
      if (this.incoming?.fileId === m.fileId) this.incoming = null;
      if (this.out?.fileId === m.fileId) this.out = null;
    }
  }

  onBinary(data: ArrayBuffer): void {
    const chunk = decodeFileChunk(data);
    const inc = this.incoming;
    if (!chunk) return;
    if (!inc?.asm || inc.fileId !== chunk.fileId) return void this.sendJson({ t: 'file.cancel', fileId: chunk.fileId, reason: 'bad_chunk', ts: Date.now() });
    const err = inc.asm.ingest(chunk);
    if (err) return this.cancelIncoming(err);
    if (chunk.chunkIndex % 16 === 0 || inc.asm.received === inc.asm.size) this.update(inc.key, { bytesDone: inc.asm.received });
  }

  private cancelIncoming(reason: 'bad_chunk' | 'overflow' | 'hash_mismatch'): void {
    const inc = this.incoming;
    if (!inc) return;
    this.sendJson({ t: 'file.cancel', fileId: inc.fileId, reason, ts: Date.now() });
    inc.asm?.free();
    this.incoming = null;
    this.update(inc.key, { status: 'failed', error: reason });
  }

  private async onDone(fileId: number): Promise<void> {
    const inc = this.incoming;
    if (!inc?.asm || inc.fileId !== fileId) return;
    const result = inc.asm.finish();
    if (!result.ok) return this.cancelIncoming('bad_chunk');
    const row = this.find(inc.key)!;
    const sha256 = await sha256HexOf(result.bytes);
    const ok = sha256 === inc.sha256;
    this.sendJson({ t: 'file.ack', fileId, ok, sha256, ts: Date.now() });
    this.incoming = null;
    if (!ok) return this.update(inc.key, { status: 'failed', error: 'hash_mismatch' });
    const blob = new Blob([result.bytes as Uint8Array<ArrayBuffer>], { type: row.mime || 'application/octet-stream' });
    this.update(inc.key, { status: 'done', bytesDone: row.size, blobUrl: URL.createObjectURL(blob), sniffed: sniffType(result.bytes.subarray(0, 16384)) });
    this.d.attest('file.received', { fileId, direction: 'assist_to_desk', name: row.name, bytes: row.size, sha256 });
  }

  private onAck(fileId: number, ok: boolean, peerSha: string): void {
    const out = this.out;
    if (!out || out.fileId !== fileId) return;
    this.out = null;
    const row = this.find(out.key);
    if (!row) return;
    if (!ok || peerSha !== out.sha256) return this.update(out.key, { status: 'failed', error: 'The receiver reported a checksum mismatch.' });
    this.update(out.key, { status: 'done', bytesDone: row.size });
    this.d.attest('file.sent', { fileId, direction: 'desk_to_assist', name: row.name, bytes: row.size, sha256: peerSha });
  }

  dispose(): void {
    this.incoming?.asm?.free();
    this.incoming = null;
    this.out?.rejected?.('session ended');
    this.out = null;
    this.rows = this.rows.map((r) => (TERMINAL.has(r.status) ? r : { ...r, status: 'cancelled', error: 'session ended' }));
    this.d.onRows(this.rows);
  }
}
