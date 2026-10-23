/**
 * Messages from the offscreen document to the worker (section 9.3): signaling out, channel state and payloads,
 * file rows and attestations, mirror statistics and transport, relay frames for the WS, and the rebuild request
 * after the third failed media recovery (section 3.5).
 */
import { fileEventDataSchema, type ClientSignalMessage } from '@indiansassist/shared';
import { offscreenToWorkerSchema } from '../shared/bus-schemas';
import type { FileRow } from '../shared/ui-state';
import type { SessionMachine } from './session-machine';

export async function handleOffscreenMessage(m: SessionMachine, raw: unknown): Promise<unknown> {
  const parsed = offscreenToWorkerSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const msg = parsed.data;
  const live = m.live;
  const sessionId = m.s?.sessionId;
  if (!live || !sessionId) return undefined;
  switch (msg.t) {
    case 'offscreen.ready':
      return undefined;
    case 'pc.signal': {
      const out = { ...msg.msg, sessionId } as ClientSignalMessage;
      m.send(out);
      return undefined;
    }
    case 'pc.state':
      m.ui.set({ status: msg.connectionState === 'connected' ? null : msg.connectionState === 'failed' ? 'Reconnecting to your technician...' : m.ui.current.status });
      return undefined;
    case 'dc.open':
      live.onChannelOpen(msg.label);
      return undefined;
    case 'dc.close':
      live.openChannels.delete(msg.label);
      return undefined;
    case 'dc.msg':
      await live.onChannelMessage(msg.label, msg.msg);
      return undefined;
    case 'file.rows':
      m.ui.set({ files: msg.rows as unknown as FileRow[] });
      return undefined;
    case 'file.attest': {
      const data = fileEventDataSchema.safeParse(msg.data);
      if (data.success) m.outbox.enqueue(sessionId, msg.action, data.data as unknown as Record<string, unknown>);
      return undefined;
    }
    case 'mirror.stats': {
      const s = m.s!;
      s.counters.bytes = msg.bytes;
      s.counters.batches = msg.batches;
      for (const [id, c] of Object.entries(msg.tabs)) live.tabCounters.set(Number(id), c);
      m.persist();
      return undefined;
    }
    case 'mirror.tooLarge':
      await live.tabs.tooLarge(msg.tabId, msg.transport);
      return undefined;
    case 'mirror.transport':
      if (live.transport !== msg.transport) {
        live.transport = msg.transport;
        if (msg.transport === 'relay') m.s!.counters.relayed = true;
        await live.tabs.updateAllBars({ relayed: msg.transport === 'relay' });
        m.persist();
      }
      return undefined;
    case 'relay.frame': {
      const t = msg.msg.t;
      if (t !== 'mirror.relay' && t !== 'control.relay') return undefined;
      m.send({ ...msg.msg, sessionId } as ClientSignalMessage);
      return undefined;
    }
    case 'rebuild.needed':
      await live.rebuild(live.iceServers);
      return undefined;
  }
}
