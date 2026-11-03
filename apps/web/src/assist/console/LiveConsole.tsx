/**
 * The live technician console for one session (contracts section 12 /app/sessions/:id).
 * Phase F section 7: touch annotation and pinch zoom on the view, and the phone and tablet layouts.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { assistMayRecord, type PackageTier, type Session, type SessionCreated } from '@indiansassist/shared';
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
import { CONSOLE_RECORDING_DISABLED_TEXT, ServerRecordingBadge } from './ServerRecordingBadge';
import { useEnterpriseLiveHooks } from './EnterpriseSlots';
import { CameraSlot } from './PhaseFSlots';
import { MobileConsoleLayout, type ConsoleSection, type ConsoleTab } from '../touch/MobileConsoleLayout';
import { useViewport } from '../touch/useViewport';

const PHASE_TEXT: Record<string, string> = {
  resuming: 'Reconnecting to the session...',
  waiting_consent: 'Waiting for consent. The Desk is reviewing what will be shared.',
  connecting: 'Consent granted. Connecting to the Desk...',
  live: 'Live',
  reconnecting: 'The media connection was interrupted. Reconnecting...',
  ending: 'Ending the session...',
  ended: 'Session ended',
};

type LiveConsoleProps = {
  sessionId: string;
  signal: SignalClient;
  cached: SessionCreated | undefined;
  helloReady: boolean;
  deskLabel: string;
  /** The REST `Session` once loaded (A.2 M4: recording mode and server recording state). */
  session?: Pick<Session, 'recordingMode' | 'serverRecording'> | null;
};

export function LiveConsole({ sessionId, signal, cached, helloReady, deskLabel, session }: LiveConsoleProps) {
  const [ctrl, setCtrl] = useState<AssistConsoleController | null>(null);
  const startArgs = useRef({ cached, helloReady });
  // Phase E section 5.3: the transcript notice and upload (stream ai; a no-op until then).
  useEnterpriseLiveHooks({ sessionId, tier: cached?.tier ?? 'p1_browser' });
  useEffect(() => {
    // Created inside the effect so React StrictMode's mount / unmount / mount gets a fresh controller.
    const c = new AssistConsoleController({ signal, sessionId });
    c.start(startArgs.current.cached, startArgs.current.helloReady);
    setCtrl(c);
    return () => c.dispose();
  }, [signal, sessionId]);
  useEffect(() => {
    if (ctrl && session) ctrl.applySession(session);
  }, [ctrl, session]);
  if (!ctrl) return <Spinner label="Opening the console" />;
  return <ConsoleView key={sessionId} ctrl={ctrl} sessionId={sessionId} signal={signal} deskLabel={deskLabel} tier={cached?.tier ?? 'p1_browser'} />;
}

function ConsoleView({
  ctrl,
  sessionId,
  signal,
  deskLabel,
  tier,
}: {
  ctrl: AssistConsoleController;
  sessionId: string;
  signal: SignalClient;
  deskLabel: string;
  tier: PackageTier;
}) {
  const { me } = useAuth();
  const snap = useSyncExternalStore(ctrl.subscribe, () => ctrl.snapshot);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fsRef = useRef<HTMLDivElement | null>(null);
  const [tool, setTool] = useState<AnnotTool | null>(null);
  const [color, setColor] = useState(ANNOT_COLORS[0]!);
  const [fit, setFit] = useState(true);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  // Phase F section 7.4: the phone and tablet layouts.
  const vp = useViewport();
  const [tab, setTab] = useState<ConsoleTab>('view');
  const onCanvas = useCallback((c: HTMLCanvasElement | null) => {
    canvasRef.current = c;
  }, []);

  useEffect(() => {
    const id = setInterval(() => setLatency(signal.latencyMs), 2000);
    return () => clearInterval(id);
  }, [signal]);

  const live = snap.phase === 'live' || snap.phase === 'connecting' || snap.phase === 'reconnecting';
  const onFirstFrame = useCallback(() => ctrl.firstFrame(), [ctrl]);
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
            recording={{ phase: snap.recording, failure: snap.recordingFailure, progress: snap.uploadProgress, result: snap.recordingResult, onRetry: () => void ctrl.retryUpload() }}
          />
        )}
      </div>
    );
  }

  const mayRecord = assistMayRecord(snap.recordingMode);
  const recBtn = !mayRecord ? (
    <span className="flex items-center gap-2">
      <Button variant="secondary" size="sm" disabled aria-describedby="console-rec-disabled">
        Record
      </Button>
      <span id="console-rec-disabled" className="text-xs text-slate-700 dark:text-slate-300">
        {CONSOLE_RECORDING_DISABLED_TEXT}
      </span>
    </span>
  ) : snap.recording === 'recording' ? (
    <Button variant="danger" size="sm" onClick={() => void ctrl.stopRecording()} aria-pressed="true">
      <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-white" /> Stop recording
    </Button>
  ) : (
    <Button variant="secondary" size="sm" disabled={!snap.remoteVideo || snap.recordingUsed} onClick={() => ctrl.startRecording(canvasRef.current)} aria-pressed="false" title={snap.recordingUsed ? 'One recording per session in this version' : undefined}>
      Record
    </Button>
  );

  const viewNode = (toolbar: ReactNode) => (
    <>
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
        onFirstFrame={onFirstFrame}
        fullscreenRef={fsRef}
        emptyText={snap.phase === 'waiting_consent' ? 'Waiting for the Desk to share their screen.' : 'No video yet.'}
        toolbar={toolbar}
        // Phase F section 7.2: P1 is view and annotate; a tap is a laser ping, a drag draws, pinch zooms locally.
        touch={{ desk: { kind: 'p1', control: false }, trackpad: false, scrollWhileZoomed: false, annotate: live && snap.remoteVideo !== null }}
        tall={vp.layout === 'phone_landscape'}
      />
      <RemoteAudio stream={snap.remoteAudio} />
    </>
  );
  const annotToolbar = (
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
  );
  const recordingCard = snap.recording !== 'idle' && snap.recording !== 'recording' && (
    <RecordingCard
      recordingId={snap.recordingResult?.id ?? null}
      phase={snap.recording}
      failure={snap.recordingFailure}
      progress={snap.uploadProgress}
      result={snap.recordingResult}
      onRetry={() => void ctrl.retryUpload()}
    />
  );
  const networkCard = (
    <Card>
      <NetworkPanel net={snap.net} signalLatency={latency} ttffMs={snap.ttffMs} relayOnly={snap.relayOnly} onRelayOnly={(on) => ctrl.setRelayOnly(on)} />
    </Card>
  );
  const voiceCard = (
    <Card>
      <VoiceControls on={snap.voiceOn} muted={snap.muted} peerMuted={snap.peerMuted} peerName={peerName} disabled={!live} onToggle={() => void ctrl.toggleVoice()} onMute={() => ctrl.toggleMute()} />
    </Card>
  );
  const chatCard = (
    <Card>
      <ChatPanel items={snap.chat} peerName={peerName} peerTyping={snap.peerTyping} disabled={!live} onSend={(t) => ctrl.sendChat(t)} onTyping={(a) => ctrl.setTyping(a)} />
    </Card>
  );
  /* Phase F section 6.6: the phone camera (stream camera; renders nothing until then). */
  const cameraSlot = (
    <CameraSlot
      session={{ id: sessionId, live: snap.phase === 'live', consoleRecording: snap.recording === 'recording' }}
      sendChat={(t) => ctrl.sendChat(t)}
      tier={tier}
    />
  );
  const filesCard = (
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
  );
  const statusLine = (
    <p className="text-sm" role="status" aria-live="polite">
      {PHASE_TEXT[snap.phase]} {snap.notice && snap.notice !== PHASE_TEXT[snap.phase] ? snap.notice : ''}
    </p>
  );
  const endDialog = (
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
  );

  if (vp.layout !== 'desktop') {
    // Phase F section 7.4: the phone and tablet layouts (P1 has no keyboard input, so no Keys tab).
    const sections: ConsoleSection[] = [
      {
        id: 'view',
        label: 'View',
        content: (
          <>
            {annotToolbar}
            <div className="flex flex-wrap items-center gap-2">{recBtn}</div>
          </>
        ),
      },
      { id: 'chat', label: 'Chat', content: chatCard },
      { id: 'files', label: 'Files', content: filesCard },
      {
        id: 'more',
        label: 'More',
        content: (
          <>
            {recordingCard}
            {networkCard}
            {voiceCard}
            {cameraSlot}
            <ShortcutHelp extra={CONSOLE_SHORTCUTS} />
          </>
        ),
      },
    ];
    return (
      <>
        <MobileConsoleLayout
          layout={vp.layout}
          title={`Session with ${peerName}`}
          badges={
            <>
              <Badge tone={snap.phase === 'live' ? 'green' : 'amber'}>{humanise(snap.phase)}</Badge>
              {snap.recording === 'recording' && <Badge tone="red">Recording</Badge>}
              {snap.recording === 'failed' && snap.recordingFailure === 'recorder' && <Badge tone="red">Recording failed</Badge>}
              <ServerRecordingBadge state={snap.serverRecording} />
            </>
          }
          onEnd={() => setConfirmEnd(true)}
          status={
            <>
              {statusLine}
              {snap.error && <Alert>{snap.error}</Alert>}
            </>
          }
          view={viewNode(null)}
          sections={sections}
          active={tab}
          onActive={setTab}
        />
        {endDialog}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Session with {peerName}</h1>
        <Badge tone={snap.phase === 'live' ? 'green' : 'amber'}>{humanise(snap.phase)}</Badge>
        {snap.recording === 'recording' && <Badge tone="red">Recording</Badge>}
        {snap.recording === 'failed' && snap.recordingFailure === 'recorder' && <Badge tone="red">Recording failed</Badge>}
        <ServerRecordingBadge state={snap.serverRecording} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {recBtn}
          <ShortcutHelp extra={CONSOLE_SHORTCUTS} />
          <Button variant="danger" onClick={() => setConfirmEnd(true)}>
            End session
          </Button>
        </div>
      </div>
      {statusLine}
      {snap.error && <Alert>{snap.error}</Alert>}
      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <Card>{viewNode(annotToolbar)}</Card>
        <div className="flex flex-col gap-4">
          {recordingCard}
          {networkCard}
          {voiceCard}
          {chatCard}
          {cameraSlot}
          {filesCard}
        </div>
      </div>
      {endDialog}
    </div>
  );
}
