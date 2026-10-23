/**
 * The Phase A side panels of the console, unchanged, for a P2 session: network (mirror channel instead of video),
 * voice, chat and files (Phase B 10: "everything else in the console is unchanged").
 */
import { useEffect, useState } from 'react';
import { ChatPanel } from '../../../components/ChatPanel';
import { FilePanel } from '../../../components/FilePanel';
import { Card } from '../../../components/ui';
import { RemoteAudio, VoiceControls } from '../../../components/VoiceControls';
import type { SignalClient } from '../../../lib/signal';
import type { MirrorConsoleController, MirrorSnapshot } from './mirrorController';
import { MirrorStatus } from './MirrorStatus';

export function MirrorSidePanels({ ctrl, snap, signal, peerName, live }: { ctrl: MirrorConsoleController; snap: MirrorSnapshot; signal: SignalClient; peerName: string; live: boolean }) {
  const [latency, setLatency] = useState<number | null>(null);
  useEffect(() => {
    const id = setInterval(() => setLatency(signal.latencyMs), 2000);
    return () => clearInterval(id);
  }, [signal]);
  return (
    <>
      <Card>
        <MirrorStatus
          transport={snap.transport}
          mirrorKbps={snap.mirrorKbps}
          sessionKbps={snap.sessionKbps}
          tabs={snap.tabs.tabs.filter((t) => t.mirrored === 'yes').length}
          net={snap.net}
          signalLatency={latency}
          stale={snap.stale}
          relayAllowed={snap.policy.allowRelayFallback}
        />
      </Card>
      <Card>
        <VoiceControls on={snap.voiceOn} muted={snap.muted} peerMuted={snap.peerMuted} peerName={peerName} disabled={!live} onToggle={() => void ctrl.toggleVoice()} onMute={() => ctrl.toggleMute()} />
        <RemoteAudio stream={snap.remoteAudio} />
      </Card>
      <Card>
        <ChatPanel items={snap.chat} peerName={peerName} peerTyping={snap.peerTyping} disabled={!live} onSend={(t) => ctrl.sendChat(t)} onTyping={(a) => ctrl.setTyping(a)} />
      </Card>
      <Card>
        <FilePanel
          transfers={snap.transfers}
          peerName={peerName}
          canSend={snap.phase === 'live'}
          onSend={(f) => ctrl.sendFile(f)}
          onAccept={(k) => ctrl.acceptFile(k)}
          onReject={(k) => ctrl.rejectFile(k)}
          onCancel={(k) => ctrl.cancelFile(k)}
        />
      </Card>
    </>
  );
}
