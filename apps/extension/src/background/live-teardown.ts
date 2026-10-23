/**
 * Ending an active session (section 3.4). Stop and revoke run in this order: stop every recorder, remove bars and
 * restore titles (cs.stop), detach the debugger, close backstage tabs (unless kept), flush attestations
 * (`control.input` windows, `mirror.stopped` with session totals, wait for the last `event.ok`), the ctrl message,
 * hard rule 2 teardown in the offscreen document, unregister the capture script, remove the debugger permission;
 * the caller then sends the WS frame that ends the session.
 */
import type { MirrorStopReason } from '@indiansassist/shared';
import type { LiveSession } from './live-session';

export async function teardownLive(
  live: LiveSession,
  reason: MirrorStopReason,
  closeBackstage: boolean,
  ctrl?: 'stop.sharing' | 'consent.revoked',
  flush = false,
): Promise<void> {
  const m = live.m;
  const s = m.s;
  m.prompts.cancelAll();
  // 1-2: recorders stopped, bars removed, titles restored (cs.stop) and the script unregistered.
  await live.registry.teardown();
  // 3: debugger detached from every tab.
  await live.debuggerControl.detachAll('close');
  // 4: technician background tabs closed unless the Desk keeps them.
  if (s) {
    for (const [id, st] of Object.entries(s.tabs)) {
      if (!st.backstage) continue;
      if (closeBackstage) await live.tabs.closeBackstageNow(Number(id));
      else await live.tabs.keepBackstage(Number(id));
    }
  }
  // 5: attestations flushed before the frame that ends the session (only while the socket can deliver them).
  live.inputs.flushAll();
  if (s && flush && m.signal?.isOpen) {
    live.attest('mirror.stopped', { reason, batches: s.counters.batches, bytes: s.counters.bytes });
    await m.outbox.flush(1000);
  }
  // 6: ctrl message on ia.ctrl, then hard rule 2 in the offscreen document.
  if (ctrl) await m.offscreen.send({ t: 'dc.send', label: 'ia.ctrl', msg: { t: ctrl, ts: Date.now() } });
  await m.offscreen.close();
  // 7: the optional debugger permission is removed so every session re-prompts.
  await live.debuggerControl.removePermission();
}
