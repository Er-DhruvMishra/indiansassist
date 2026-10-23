/**
 * Offscreen document entry (section 7 "Offscreen document decision"): owns the RTCPeerConnection, the six
 * channels, the microphone, deflate framing, the relay pacer, the file engine and the stylesheet fetch. Talks to
 * the worker over the bus (`to: 'offscreen'`) and to capture scripts over `ia.mirror` Ports.
 */
import { onBus, sendBus } from '../shared/bus';
import { contentToOffscreenSchema, workerToOffscreenSchema, type WorkerToOffscreen } from '../shared/bus-schemas';
import { MIRROR_PORT, RELAY_FALLBACK_AFTER_MS } from '../shared/constants';
import { ext } from '../shared/api';
import { OffscreenChannels } from './channels';
import { CssFetcher } from './css-fetch';
import { FileEngine } from './files';
import { MirrorSender } from './mirror-sender';
import { DeskPeer } from './peer';
import { RelayPacer } from './relay-pacer';
import { Voice } from './voice';

const toWorker = (msg: { t: string } & Record<string, unknown>) => void sendBus({ ...msg, to: 'worker' });
const ports = new Map<number, chrome.runtime.Port>();
let peer: DeskPeer | null = null;
let relayAllowed = false;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
let lastStats = { at: Date.now(), bytes: 0 };

const relay = new RelayPacer((frame) => {
  toWorker({ t: 'relay.frame', msg: frame });
  return true;
});
const files: FileEngine = new FileEngine({
  channel: (): RTCDataChannel | null => channels.get('ia.file'),
  onRows: (rows) => toWorker({ t: 'file.rows', rows }),
  attest: (action, data) => toWorker({ t: 'file.attest', action, data }),
});
const mirror: MirrorSender = new MirrorSender({
  channel: (): RTCDataChannel | null => channels.get('ia.mirror'),
  relayAllowed: () => relayAllowed,
  relay,
  maxMessageSize: () => peer?.maxMessageSize() ?? 65536,
  toTab: (tabId, msg) => ports.get(tabId)?.postMessage(msg),
  onTooLarge: (tabId, transport) => toWorker({ t: 'mirror.tooLarge', tabId, transport }),
  onTransport: (transport) => toWorker({ t: 'mirror.transport', transport }),
});
const channels: OffscreenChannels = new OffscreenChannels({ toWorker, files, mirror, relay, relayAllowed: () => relayAllowed });
const voice = new Voice();
const css = new CssFetcher();

function createPeer(iceServers: RTCIceServer[], restart: boolean): void {
  peer?.close();
  channels.clear();
  peer = new DeskPeer({
    iceServers,
    restart,
    send: (msg) => toWorker({ t: 'pc.signal', msg }),
    onChannel: (label, ch) => channels.attach(label, ch),
    onState: (connectionState, path) => toWorker({ t: 'pc.state', connectionState, path }),
    onTrack: (track) => voice.playRemote(track),
    onGiveUp: () => toWorker({ t: 'rebuild.needed' }),
  });
  voice.reattach((t, s) => peer?.addTrack(t, s) ?? null);
  // Relay fallback: the mirror / control channels are not open 5 s after the connection was built (4.6).
  if (fallbackTimer) clearTimeout(fallbackTimer);
  fallbackTimer = setTimeout(() => {
    if (relayAllowed && !channels.isOpen('ia.mirror')) mirror.setTransport('relay');
  }, RELAY_FALLBACK_AFTER_MS);
  for (const tabId of ports.keys()) mirror.snapshot(tabId);
}

function teardown(): void {
  if (fallbackTimer) clearTimeout(fallbackTimer);
  files.dispose();
  relay.stop();
  voice.stop();
  peer?.close();
  peer = null;
  channels.clear();
}

async function handle(msg: WorkerToOffscreen): Promise<unknown> {
  switch (msg.t) {
    case 'ping':
      return { ok: true };
    case 'pc.create':
      relayAllowed = msg.relayAllowed;
      createPeer(msg.iceServers, msg.restart);
      return { ok: true };
    case 'pc.signal':
      await peer?.handle(msg.msg as { t: string });
      return { ok: true };
    case 'pc.ice':
      peer?.setIceServers(msg.iceServers);
      return { ok: true };
    case 'pc.close':
      teardown();
      return { ok: true };
    case 'dc.send':
      return { ok: channels.sendJson(msg.label, msg.msg) };
    case 'file.send':
      void files.send(msg.blobUrl, msg.name, msg.mime).catch((e: unknown) => toWorker({ t: 'file.rows', rows: [], error: String(e) }));
      return { ok: true };
    case 'file.decision':
      files.decide(msg.key, msg.accept);
      return { ok: true };
    case 'voice.mute':
      await voice.setMuted(msg.muted, (t, s) => peer?.addTrack(t, s) ?? null);
      return { ok: true };
    case 'mirror.focus':
      mirror.setFocus(msg.tabId, ports.keys());
      if (msg.tabId !== null) mirror.snapshot(msg.tabId);
      return { ok: true };
    case 'mirror.snapshot':
      mirror.snapshot(msg.tabId);
      return { ok: true };
    case 'relay.policy':
      relayAllowed = msg.allowed;
      return { ok: true };
    case 'relay.inbound':
      channels.relayInbound(msg.msg);
      return { ok: true };
  }
}

onBus('offscreen', (raw, sender) => {
  if (sender.id !== ext().runtime.id) return undefined;
  const parsed = workerToOffscreenSchema.safeParse(raw);
  return parsed.success ? handle(parsed.data) : undefined;
});

ext().runtime.onConnect.addListener((port) => {
  const tabId = port.sender?.tab?.id;
  if (port.name !== MIRROR_PORT || tabId === undefined || port.sender?.frameId !== 0 || port.sender.id !== ext().runtime.id) return;
  ports.get(tabId)?.disconnect();
  ports.set(tabId, port);
  port.postMessage({ t: 'oc.focus', focused: mirror.focused === tabId });
  port.onMessage.addListener((raw: unknown) => {
    const parsed = contentToOffscreenSchema.safeParse(raw);
    if (!parsed.success) return;
    const m = parsed.data;
    if (m.t === 'cs.events') void mirror.ingest(tabId, m.events, m.snapshot);
    else if (m.t === 'cs.fetchCss') void css.fetchFor(tabId, m.url).then((text) => port.postMessage({ t: 'oc.css', url: m.url, text }));
    else if (m.t === 'cs.dropped') mirror.snapshot(tabId);
  });
  port.onDisconnect.addListener(() => {
    if (ports.get(tabId) === port) ports.delete(tabId);
    css.forget(tabId);
  });
});

setInterval(() => {
  mirror.checkAcks();
  const t = mirror.totals();
  const now = Date.now();
  const kbps = ((t.bytes - lastStats.bytes) * 8) / Math.max(1, now - lastStats.at);
  lastStats = { at: now, bytes: t.bytes };
  if (peer) toWorker({ t: 'mirror.stats', bytes: t.bytes, batches: t.batches, kbps: Math.max(0, kbps), transport: mirror.transport, tabs: t.tabs });
}, 2000);

toWorker({ t: 'offscreen.ready' });
