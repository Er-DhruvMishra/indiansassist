/** The live technician console for one session (contracts section 12 /app/sessions/:id). */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionCreated } from '@indiansassist/shared';
import { useAuth } from '../../auth/AuthContext';
import { ChatPanel } from '../../components/ChatPanel';
import { Dialog } from '../../components/Dialog';
import { FilePanel } from '../../components/FilePanel';
import { CONSOLE_SHORTCUTS, ShortcutHelp, shouldIgnoreKey } from '../../components/ShortcutHelp';
import { Alert, Badge, Button, Card, Spinner } from '../../components/ui';
import { RemoteAudio, VoiceControls } from '../../components/VoiceControls';
import { useAsync } from '../../hooks/useAsync';
import { makeClear, type AnnotTool } from '../../lib/annotation';
import { sessionsApi } from '../../lib/endpoints';
import { humanise } from '../../lib/format';
import type { SignalClient } from '../../lib/signal';
import { describeRemote } from '../../lib/stats';
import { AnnotToolbar, ANNOT_COLORS } from './AnnotToolbar';
import { AssistConsoleController } from './controller';
import { EndedView, RecordingCard } from './EndedView';
import { NetworkPanel } from './NetworkPanel';
import { RemoteView } from './RemoteView';

const PHASE_TEXT: Record<string, string> = {
  resuming: 'Reconnecting to the session...',
  waiting_consent: 'Waiting for consent. The Desk is reviewing what will be shared.',
  connecting: 'Consent granted. Connecting to the Desk...',
  live: 'Live',
  ending: 'Ending the session...',
  ended: 'Session ended',
};

export function LiveConsole({ sessionId, signal, cached, helloReady, deskLabel }: { sessionId: string; signal: SignalClient; cached: SessionCreated | undefined; helloReady: boolean; deskLabel: string }) {
  const [ctrl, setCtrl] = useState<AssistConsoleController | null>(null);
  const startArgs = useRef({ cached, helloReady });
  useEffect(() => {
    // Created inside the effect so React StrictMode's mount / unmount / mount gets a fresh controller.
    const c = new AssistConsoleController({ signal, sessionId });
    c.start(startArgs.current.cached, startArgs.current.helloReady);
    setCtrl(c);
    return () => c.dispose();
  }, [signal, sessionId]);
  if (!ctrl) return <Spinner label="Opening the console" />;
  return <ConsoleView key={sessionId} ctrl={ctrl} sessionId={sessionId} signal={signal} deskLabel={deskLabel} />;
}

function ConsoleView({ ctrl, sessionId, signal, deskLabel }: { ctrl: AssistConsoleController; sessionId: string; signal: SignalClient; deskLabel: string }) {
  const { me } = useAuth();
  const snap = useSyncExternalStore(ctrl.subscribe, () => ctrl.snapshot);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fsRef = useRef<HTMLDivElement | null>(null);
  const [tool, setTool] = useState<AnnotTool | null>(null);
  const [color, setColor] = useState(ANNOT_COLORS[0]!);
  const [fit, setFit] = useState(true);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const onCanvas = useCallback((c: HTMLCanvasElement | null) => {
    canvasRef.current = c;
  }, []);

  useEffect(() => {
    const id = setInterval(() => setLatency(signal.latencyMs), 2000);
    return () => clearInterval(id);
  }, [signal]);

  const live = snap.phase === 'live' || snap.phase === 'connecting';
  const peerName = snap.created?.desk.label ?? deskLabel;

  const fullscreen = useCallback(() => {
    const el = fsRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void el.requestFullscreen?.().catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreKey(e)) return;
      const k = e.key.toLowerCase();
      const tools: Record<string, AnnotTool> = { a: 'arrow', r: 'rect', h: 'highlight', p: 'pointer' };
      if (tools[k] && live) setTool((t) => (t === tools[k] ? null : tools[k]!));
      else if (k === 'c' && live) ctrl.sendAnnot(makeClear());
      else if (k === 'f') fullscreen();
      else if (k === 'z') setFit((f) => !f);
      else if (k === 'm' && snap.voiceOn) ctrl.toggleMute();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctrl, live, fullscreen, snap.voiceOn]);

  const detail = useAsync(() => (snap.phase === 'ended' ? sessionsApi.get(sessionId) : Promise.resolve(null)), [snap.phase, sessionId]);

  if (snap.phase === 'ended') {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="blue">
          Session ended{snap.ended ? `: ${humanise(snap.ended.endReason)}` : ''}. All local media was stopped.
        </Alert>
        {detail.loading && <Spinner label="Loading session record" />}
        {detail.data && (
          <EndedView
            detail={detail.data}
            recording={{ phase: snap.recording, progress: snap.uploadProgress, result: snap.recordingResult, onRetry: () => void ctrl.retryUpload() }}
          />
        )}
      </div>
    );
  }

  const recBtn = snap.recording === 'recording' ? (
    <Button variant="danger" size="sm" onClick={() => void ctrl.stopRecording()} aria-pressed="true">
      <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-white" /> Stop recording
    </Button>
  ) : (
    <Button variant="secondary" size="sm" disabled={!snap.remoteVideo || snap.recordingUsed} onClick={() => ctrl.startRecording(canvasRef.current)} aria-pressed="false" title={snap.recordingUsed ? 'One recording per session in this version' : undefined}>
      Record
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Session with {peerName}</h1>
        <Badge tone={snap.phase === 'live' ? 'green' : 'amber'}>{humanise(snap.phase)}</Badge>
        {snap.recording === 'recording' && <Badge tone="red">Recording</Badge>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {recBtn}
          <ShortcutHelp extra={CONSOLE_SHORTCUTS} />
          <Button variant="danger" onClick={() => setConfirmEnd(true)}>
            End session
          </Button>
        </div>
      </div>
      <p className="text-sm" role="status" aria-live="polite">
        {PHASE_TEXT[snap.phase]} {snap.notice ?? ''}
      </p>
      {snap.error && <Alert>{snap.error}</Alert>}
      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <Card>
          <RemoteView
            stream={snap.remoteVideo}
            annot={snap.annot}
            tool={live ? tool : null}
            color={color}
            fit={fit}
            watermark={{ name: me?.user.name ?? '', userId: me?.user.id ?? '', sessionId }}
            description={describeRemote(snap.net, snap.remoteVideo !== null)}
            onAnnot={(m) => ctrl.sendAnnot(m)}
            onCanvas={onCanvas}
            fullscreenRef={fsRef}
            emptyText={snap.phase === 'waiting_consent' ? 'Waiting for the Desk to share their screen.' : 'No video yet.'}
            toolbar={
              <AnnotToolbar
                tool={tool}
                color={color}
                fit={fit}
                disabled={!live || !snap.remoteVideo}
                onTool={setTool}
                onColor={setColor}
                onClear={() => ctrl.sendAnnot(makeClear())}
                onFit={() => setFit((f) => !f)}
                onFullscreen={fullscreen}
              />
            }
          />
          <RemoteAudio stream={snap.remoteAudio} />
        </Card>
        <div className="flex flex-col gap-4">
          {snap.recording !== 'idle' && snap.recording !== 'recording' && (
            <RecordingCard
              recordingId={snap.recordingResult?.id ?? null}
              phase={snap.recording}
              progress={snap.uploadProgress}
              result={snap.recordingResult}
              onRetry={() => void ctrl.retryUpload()}
            />
          )}
          <Card>
            <NetworkPanel net={snap.net} signalLatency={latency} relayOnly={snap.relayOnly} onRelayOnly={(on) => ctrl.setRelayOnly(on)} />
          </Card>
          <Card>
            <VoiceControls on={snap.voiceOn} muted={snap.muted} peerMuted={snap.peerMuted} peerName={peerName} disabled={!live} onToggle={() => void ctrl.toggleVoice()} onMute={() => ctrl.toggleMute()} />
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
        </div>
      </div>
      <Dialog open={confirmEnd} title="End this session?" onClose={() => setConfirmEnd(false)}>
        <p className="mb-4 text-sm">Screen sharing stops for the Desk immediately. A running recording is stopped and uploaded.</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmEnd(false)}>
            Keep session
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirmEnd(false);
              void ctrl.endSession();
            }}
          >
            End session
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
