/**
 * The P3 technician console (docs/specs/phase-c-contracts.md section 13.4), mounted by /app/sessions/:id when
 * `session.tier === 'p3_portable'` (sibling of `MirrorConsole`). Video of the viewed monitor (or the mosaic) through
 * the A watermark `RemoteView`, the security code in the header, the input mode, monitors, clipboard, elevation,
 * playbooks, agent statistics, chat and files. The logic lives in `AgentConsoleController`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { sasDisplay, type AgentCapabilities, type SessionCreated } from '@indiansassist/shared';
import { useAuth } from '../../../auth/AuthContext';
import { ChatPanel } from '../../../components/ChatPanel';
import { Dialog } from '../../../components/Dialog';
import { FilePanel } from '../../../components/FilePanel';
import { Alert, Badge, Button, Card, Spinner } from '../../../components/ui';
import { EMPTY_ANNOT, applyAnnot, makeClear, pruneAnnot, type AnnotTool } from '../../../lib/annotation';
import { humanise } from '../../../lib/format';
import type { SignalClient } from '../../../lib/signal';
import { AnnotToolbar, ANNOT_COLORS } from '../AnnotToolbar';
import { NetworkPanel } from '../NetworkPanel';
import { AgentConsoleController, type AgentConsoleDeps } from './agentConsoleController';
import { ClipboardToggle, NavButtons } from './AgentControls';
import { AgentScreen } from './AgentScreen';
import { AgentStats } from './AgentStats';
import { ElevationDialog, ELEVATED_NOTE } from './ElevationDialog';
import { InputModeToggle } from './InputModeToggle';
import { MonitorPicker } from './MonitorPicker';
import { PlaybookPanel } from './PlaybookPanel';
import { SasConfirmDialog, SAS_STOP_TEXT } from './SasConfirmDialog';
import { controlBlocker, hasFeature, levelAllows, levelChip, sasOk } from './agentState';
import type { OverlayActions } from './InputOverlay';

const PHASE_TEXT: Record<string, string> = {
  resuming: 'Reconnecting to the session...',
  waiting_consent: 'Waiting for consent. The user is reviewing what will be shared.',
  connecting: 'Consent granted. Waiting for the Desk to connect...',
  securing: 'Securing the connection',
  live: 'Live',
  ending: 'Ending the session...',
  ended: 'Session ended',
};

export type AgentConsoleProps = {
  sessionId: string;
  signal: SignalClient;
  cached: SessionCreated | undefined;
  helloReady: boolean;
  deskLabel: string;
  capabilities?: AgentCapabilities | null;
  /** Test injection (fake connection, fixed handshake, REST stubs). */
  deps?: Partial<AgentConsoleDeps>;
};

export function AgentConsole({ sessionId, signal, cached, helloReady, deskLabel, capabilities, deps }: AgentConsoleProps) {
  const [ctrl, setCtrl] = useState<AgentConsoleController | null>(null);
  const startArgs = useRef({ cached, helloReady, capabilities, deps });
  useEffect(() => {
    const a = startArgs.current;
    const c = new AgentConsoleController({ signal, sessionId, ...a.deps });
    c.start(a.cached, a.helloReady, a.capabilities ?? null);
    setCtrl(c);
    return () => c.dispose();
  }, [signal, sessionId]);
  useEffect(() => {
    if (ctrl && capabilities) ctrl.setCapabilities(capabilities);
  }, [ctrl, capabilities]);
  if (!ctrl) return <Spinner label="Opening the console" />;
  return <AgentConsoleView ctrl={ctrl} sessionId={sessionId} deskLabel={deskLabel} />;
}

export function AgentConsoleView({ ctrl, sessionId, deskLabel }: { ctrl: AgentConsoleController; sessionId: string; deskLabel: string }) {
  const { me } = useAuth();
  const snap = useSyncExternalStore(ctrl.subscribe, () => ctrl.snapshot);
  const fsRef = useRef<HTMLDivElement | null>(null);
  const [tool, setTool] = useState<AnnotTool | null>(null);
  const [color, setColor] = useState(ANNOT_COLORS[0]!);
  const [annot, setAnnot] = useState(EMPTY_ANNOT);
  const [elevOpen, setElevOpen] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setAnnot((a) => pruneAnnot(a)), 500);
    return () => clearInterval(t);
  }, []);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const onCanvas = useCallback(() => undefined, []);
  const onFirstFrame = useCallback(() => undefined, []);
  const tier = snap.created?.tier ?? 'p3_portable';
  const peerName = snap.created?.desk.label ?? deskLabel;
  const secured = snap.sec.state === 'established';
  const controlling = snap.inputMode === 'control' && controlBlocker(snap) === null;
  const elevated = levelAllows(tier, snap.consent.level, 'elevated');
  const actions = useMemo<OverlayActions>(
    () => ({
      pointer: (m, k, nx, ny, b, mods) => ctrl.pointer(m, k, nx, ny, b, mods),
      scroll: (m, nx, ny, dx, dy) => ctrl.scroll(m, nx, ny, dx, dy),
      key: (k, e) => ctrl.key(k, e),
      text: (t) => ctrl.typeText(t),
      clipboard: (t) => ctrl.sendClipboard(t),
      release: () => ctrl.releaseModifiers(),
    }),
    [ctrl],
  );

  if (snap.phase === 'ended') {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="blue">Session ended{snap.ended ? `: ${humanise(snap.ended.endReason)}` : ''}. All local media was stopped.</Alert>
        <SasHistory history={snap.sasHistory} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Session with {peerName}</h1>
        <Badge tone={snap.phase === 'live' ? 'green' : 'amber'}>{humanise(snap.phase)}</Badge>
        {snap.sec.sas && (
          <span className="rounded bg-slate-100 px-2 py-1 font-mono text-sm dark:bg-slate-800" title={SAS_STOP_TEXT} data-testid="sas-header">
            Security code {sasDisplay(snap.sec.sas)}
          </span>
        )}
        {secured && !sasOk(snap) && <Badge tone="amber">Code not confirmed</Badge>}
        <div className="ml-auto flex gap-2">
          <Button variant="danger" onClick={() => setConfirmEnd(true)}>
            End session
          </Button>
        </div>
      </div>
      <p className="text-sm" role="status" aria-live="polite">
        {PHASE_TEXT[snap.phase]} {snap.notice ?? ''}
      </p>
      {snap.error && <Alert>{snap.error}</Alert>}
      {snap.captureNotice && <Alert tone="amber">{snap.captureNotice}</Alert>}
      {elevated && <Alert tone="blue">{ELEVATED_NOTE}</Alert>}
      <div className="grid gap-4 xl:grid-cols-[1fr_24rem]">
        <Card>
          <div className="mb-3 flex flex-col gap-2">
            <InputModeToggle
              tier={tier}
              level={snap.consent.level}
              chip={levelChip(snap)}
              mode={snap.inputMode}
              secured={secured}
              sasConfirmed={sasOk(snap)}
              canElevate={hasFeature(snap, 'elevation')}
              onMode={(m) => ctrl.setInputMode(m)}
              onAskControl={(r) => void ctrl.requestControl(r)}
              onElevate={() => setElevOpen(true)}
              onConfirmSas={() => ctrl.openSasPrompt(true)}
            />
            <MonitorPicker monitors={snap.monitors} selected={snap.selected} viewed={snap.viewed} floorMode={snap.agentStats?.floorMode ?? false} disabled={!secured} onView={(v) => void ctrl.view(v)} />
            <NavButtons show={hasFeature(snap, 'nav')} disabled={!controlling} onNav={(a) => ctrl.nav(a)} />
            {controlling && <p className="text-xs text-slate-600 dark:text-slate-400">Text is typed as you see it; shortcuts follow the user&apos;s keyboard layout. Hold Escape for 1 s to release the keyboard.</p>}
          </div>
          <AgentScreen
            monitors={snap.monitors}
            viewed={snap.viewed}
            streams={snap.streams}
            controlling={controlling}
            actions={actions}
            annot={annot}
            tool={tool}
            color={color}
            watermark={{ name: me?.user.name ?? '', userId: me?.user.id ?? '', sessionId }}
            onAnnot={(m) => {
              setAnnot((a) => applyAnnot(a, m));
              ctrl.sendAnnot(m);
            }}
            onCanvas={onCanvas}
            onFirstFrame={onFirstFrame}
            fullscreenRef={fsRef}
            emptyText={snap.phase === 'waiting_consent' ? 'Waiting for the user to share their screen.' : secured ? 'No video yet.' : 'Securing the connection'}
            toolbar={
              <AnnotToolbar tool={tool} color={color} fit disabled={!secured || controlling} onTool={setTool} onColor={setColor} onClear={() => {
                  const m = makeClear();
                  setAnnot((a) => applyAnnot(a, m));
                  ctrl.sendAnnot(m);
                }} onFit={() => undefined} onFullscreen={() => void fsRef.current?.requestFullscreen?.().catch(() => undefined)} />
            }
          />
        </Card>
        <div className="flex flex-col gap-4">
          <Card>
            <NetworkPanel net={snap.net} signalLatency={null} relayOnly={false} onRelayOnly={() => undefined} />
            <div className="mt-3">
              <AgentStats stats={snap.agentStats} glassMs={snap.glassMs} />
            </div>
          </Card>
          <Card>
            <ClipboardToggle on={snap.clipboardSync} allowed={ctrl.clipboardAllowed} received={snap.clipboardReceived} onToggle={(on) => ctrl.setClipboardSync(on)} />
          </Card>
          <Card>
            <PlaybookPanel
              playbooks={snap.playbooks}
              runs={snap.runs}
              elevated={elevated}
              canRun={secured && levelAllows(tier, snap.consent.level, 'control')}
              supported={hasFeature(snap, 'playbooks')}
              onRun={(pb, args) => ctrl.runPlaybook(pb, args)}
              onCancel={(id) => void ctrl.cancelPlaybook(id)}
            />
          </Card>
          <Card>
            <ChatPanel items={snap.chat} peerName={peerName} peerTyping={snap.peerTyping} disabled={!secured} onSend={(t) => ctrl.sendChat(t)} onTyping={(a) => ctrl.setTyping(a)} />
          </Card>
          <Card>
            <FilePanel
              transfers={snap.transfers}
              peerName={peerName}
              canSend={secured}
              onSend={(f) => ctrl.sendFile(f)}
              onAccept={(k) => ctrl.acceptFile(k)}
              onReject={(k) => ctrl.rejectFile(k)}
              onCancel={(k) => ctrl.cancelFile(k)}
            />
          </Card>
          <Card>
            <SasHistory history={snap.sasHistory} />
          </Card>
        </div>
      </div>
      <SasConfirmDialog
        open={snap.sasPrompt && secured && !sasOk(snap)}
        gen={snap.sec.gen}
        requireConfirm={snap.requireSasConfirm}
        onConfirm={(t) => ctrl.confirmSas(t)}
        onSkip={() => ctrl.skipSas()}
        onClose={() => ctrl.openSasPrompt(false)}
      />
      <ElevationDialog open={elevOpen} state={snap.elevation} onSubmit={(r) => void ctrl.requestElevation(r)} onClose={() => setElevOpen(false)} />
      <Dialog open={confirmEnd} title="End this session?" onClose={() => setConfirmEnd(false)}>
        <p className="mb-4 text-sm">Screen sharing stops for the Desk immediately.</p>
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

/** Every security code of the session by key generation (section 1.3 step 7). */
function SasHistory({ history }: { history: { gen: number; sas: string }[] }) {
  if (history.length === 0) return null;
  return (
    <section aria-label="Security codes">
      <h2 className="mb-1 text-sm font-semibold">Security codes this session</h2>
      <ul className="text-xs">
        {history.map((h) => (
          <li key={h.gen} className="font-mono">
            Connection {h.gen + 1}: {sasDisplay(h.sas)}
          </li>
        ))}
      </ul>
    </section>
  );
}
