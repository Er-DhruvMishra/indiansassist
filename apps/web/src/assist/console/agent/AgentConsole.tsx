/**
 * The P3 technician console (docs/specs/phase-c-contracts.md section 13.4), mounted by /app/sessions/:id when
 * `session.tier === 'p3_portable'` (sibling of `MirrorConsole`). Video of the viewed monitor (or the mosaic) through
 * the A watermark `RemoteView`, the security code in the header, the input mode, monitors, clipboard, elevation,
 * playbooks, agent statistics, voice (when the Desk advertises `voice`), chat and files. The logic lives in
 * `AgentConsoleController`.
 *
 * Phase F section 7: touch gestures on the view (tap, long press, drag, two-finger scroll, pinch zoom), the keys bar,
 * and the phone and tablet layouts (`MobileConsoleLayout`); the desktop layout is unchanged.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { sasDisplay, type AgentCapabilities, type SessionCreated } from '@indiansassist/shared';
import { useAuth } from '../../../auth/AuthContext';
import { ChatPanel } from '../../../components/ChatPanel';
import { Dialog } from '../../../components/Dialog';
import { FilePanel } from '../../../components/FilePanel';
import { RemoteAudio, VoiceControls } from '../../../components/VoiceControls';
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
import { controlBlocker, deskControlBlocker, hasFeature, levelAllows, levelChip, sasOk } from './agentState';
import { NoScreenSlot, useEnterpriseLiveHooks } from '../EnterpriseSlots';
import { CameraSlot, DeskKeepSlot } from '../PhaseFSlots';
import { PolicyState, ScreenLockedNotice, UnattendedBanner, type UnattendedSessionInfo } from './UnattendedBanner';
import { stopNotice } from './agentController';
import type { OverlayActions } from './InputOverlay';
import type { RemoteTouch } from '../RemoteView';
import { KeysBar } from '../../touch/KeysBar';
import { MobileConsoleLayout, type ConsoleSection, type ConsoleTab } from '../../touch/MobileConsoleLayout';
import { TouchToggles, defaultTrackpad, nativeKeyActions } from '../../touch/TouchControls';
import { useViewport } from '../../touch/useViewport';

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
  /**
   * Phase D section 13.4: a P4 device session. Absent for a P3 portable session; present (with `unattended: false`)
   * for an attended device session, so the console always says which kind of session this is.
   */
  device?: UnattendedSessionInfo;
  /** Test injection (fake connection, fixed handshake, REST stubs). */
  deps?: Partial<AgentConsoleDeps>;
  /** Phase F section 7.3: the device's service advertises `sas` (P4), so the keys bar offers Ctrl+Alt+Del. */
  deskSas?: boolean;
};

export function AgentConsole({ sessionId, signal, cached, helloReady, deskLabel, capabilities, device, deps, deskSas }: AgentConsoleProps) {
  const [ctrl, setCtrl] = useState<AgentConsoleController | null>(null);
  const startArgs = useRef({ cached, helloReady, capabilities, deps });
  // Phase E section 5.3: the transcript notice and upload (stream ai; a no-op until then).
  useEnterpriseLiveHooks({ sessionId, tier: cached?.tier ?? null });
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
  return <AgentConsoleView ctrl={ctrl} sessionId={sessionId} deskLabel={deskLabel} device={device} deskSas={deskSas} />;
}

export function AgentConsoleView({
  ctrl,
  sessionId,
  deskLabel,
  device,
  deskSas = false,
}: {
  ctrl: AgentConsoleController;
  sessionId: string;
  deskLabel: string;
  device?: UnattendedSessionInfo;
  /** Phase F section 7.3: the Desk's service advertises `sas` (Ctrl+Alt+Del on the keys bar). */
  deskSas?: boolean;
}) {
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
  // Phase F section 7: the layout, the touch toggles and the keys bar.
  const vp = useViewport();
  const [tab, setTab] = useState<ConsoleTab>('view');
  const [trackpad, setTrackpad] = useState(() => defaultTrackpad());
  const [scrollZoomed, setScrollZoomed] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [keysFocus, setKeysFocus] = useState(0);
  const tier = snap.created?.tier ?? 'p3_portable';
  const peerName = snap.created?.desk.label ?? deskLabel;
  const secured = snap.sec.state === 'established';
  const controlling = snap.inputMode === 'control' && controlBlocker(snap) === null;
  const elevated = levelAllows(tier, snap.consent.level, 'elevated');
  const voice = hasFeature(snap, 'voice');
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
  const openKeyboard = useCallback(() => {
    setTab('keys');
    setKeysOpen(true);
    setKeysFocus((n) => n + 1);
  }, []);
  // Section 7.2: an Android host Desk advertises `nav`; it maps a button-2 click to its long press.
  const deskKind = hasFeature(snap, 'nav') ? 'android' : 'native';
  const touchFor = useCallback(
    (monitorId: number): RemoteTouch => ({
      desk: controlling ? { kind: deskKind, control: true } : secured ? { kind: 'p1', control: false } : { kind: 'none', control: false },
      trackpad,
      scrollWhileZoomed: scrollZoomed,
      annotate: secured && !controlling,
      onKeyboardToggle: () => (keysOpen && tab === 'keys' ? setKeysOpen(false) : openKeyboard()),
      onOp: ({ op, args }) => {
        const n = (k: string) => Number(args[k] ?? 0);
        if (op === 'os.pointer') ctrl.pointer(monitorId, args['kind'] as 'move' | 'down' | 'up' | 'click' | 'dblclick', n('nx'), n('ny'), n('button'));
        else if (op === 'os.scroll') ctrl.scroll(monitorId, n('nx'), n('ny'), n('dx'), n('dy'));
      },
    }),
    [ctrl, controlling, deskKind, secured, trackpad, scrollZoomed, keysOpen, tab, openKeyboard],
  );
  const keyActions = nativeKeyActions({
    key: (k, e) => ctrl.key(k, e),
    typeText: (t) => ctrl.typeText(t),
    ...(snap.clipboardSync && ctrl.clipboardAllowed ? { paste: (t: string) => ctrl.sendClipboard(t) } : {}),
    ...(deskSas ? { sas: () => ctrl.sas() } : {}),
    ...(hasFeature(snap, 'nav') ? { nav: (a: 'back' | 'home' | 'recents') => ctrl.nav(a) } : {}),
  });

  if (snap.phase === 'ended') {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="blue">Session ended{snap.ended ? `: ${humanise(snap.ended.endReason)}` : ''}. All local media was stopped.</Alert>
        {snap.deskStopReason && <Alert tone="amber">{stopNotice(snap.deskStopReason)}</Alert>}
        <SasHistory history={snap.sasHistory} />
      </div>
    );
  }

  const mobile = vp.layout !== 'desktop';
  const statusLine = (
    <p className="text-sm" role="status" aria-live="polite">
      {PHASE_TEXT[snap.phase]} {snap.notice ?? ''}
    </p>
  );
  const alerts = (
    <>
      {device && <UnattendedBanner info={device} />}
      {device?.screenLocked && <ScreenLockedNotice />}
      {snap.error && <Alert>{snap.error}</Alert>}
      {snap.captureNotice && <Alert tone="amber">{snap.captureNotice}</Alert>}
      {elevated && <Alert tone="blue">{ELEVATED_NOTE}</Alert>}
      {/* Phase F section 3.4b: the Desk user's Keep choice, read-only (stream fixes; renders nothing until then). */}
      <DeskKeepSlot kept={snap.kept} />
    </>
  );
  const inputMode = (
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
      deskUnavailable={deskControlBlocker(snap)}
    />
  );
  const monitorPicker = <MonitorPicker monitors={snap.monitors} selected={snap.selected} viewed={snap.viewed} floorMode={snap.agentStats?.floorMode ?? false} disabled={!secured} onView={(v) => void ctrl.view(v)} />;
  const navButtons = <NavButtons show={hasFeature(snap, 'nav')} disabled={!controlling} onNav={(a) => ctrl.nav(a)} />;
  const annotToolbar = (
    <AnnotToolbar tool={tool} color={color} fit disabled={!secured || controlling} onTool={setTool} onColor={setColor} onClear={() => {
        const m = makeClear();
        setAnnot((a) => applyAnnot(a, m));
        ctrl.sendAnnot(m);
      }} onFit={() => undefined} onFullscreen={() => void fsRef.current?.requestFullscreen?.().catch(() => undefined)} />
  );
  const screen = (toolbar: ReactNode) => (
    // Phase E section 7.4: the no-screen state of a Desk without `screen` (stream linux).
    <NoScreenSlot capabilities={snap.capabilities}>
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
      toolbar={toolbar}
      touch={touchFor}
      tall={vp.layout === 'phone_landscape'}
    />
    </NoScreenSlot>
  );
  const keysBar = (
    <>
      {!controlling && <p className="text-sm text-slate-700 dark:text-slate-300">{deskControlBlocker(snap) ?? 'Take control to type on the remote computer.'}</p>}
      <KeysBar actions={keyActions} disabled={!controlling} focusSignal={keysFocus} />
    </>
  );
  const touchToggles = <TouchToggles trackpad={trackpad} onTrackpad={setTrackpad} scroll={scrollZoomed} onScroll={setScrollZoomed} disabled={!controlling} />;
  const statsCard = (
    <Card>
      <NetworkPanel net={snap.net} signalLatency={null} relayOnly={false} onRelayOnly={() => undefined} />
      <div className="mt-3">
        <AgentStats stats={snap.agentStats} glassMs={snap.glassMs} />
      </div>
    </Card>
  );
  const voiceCard = voice && (
    <Card>
      <VoiceControls
        on={snap.voiceOn}
        muted={snap.muted}
        peerMuted={snap.peerMuted}
        peerName={peerName}
        disabled={!secured}
        labels={{ on: 'Turn microphone on', off: 'Turn microphone off' }}
        onToggle={() => void ctrl.toggleVoice()}
      />
      <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">The Desk has no echo cancellation; if you hear an echo, ask the user to wear a headset.</p>
      <RemoteAudio stream={snap.remoteAudio} />
    </Card>
  );
  const policyCard = device?.policy && (
    <Card>
      <PolicyState policy={device.policy} unattended={device.unattended} />
    </Card>
  );
  const clipboardCard = (
    <Card>
      <ClipboardToggle on={snap.clipboardSync} allowed={ctrl.clipboardAllowed} supported={hasFeature(snap, 'clipboard')} received={snap.clipboardReceived} onToggle={(on) => ctrl.setClipboardSync(on)} />
    </Card>
  );
  const playbookCard = (
    <Card>
      <PlaybookPanel
        playbooks={snap.playbooks}
        runs={snap.runs}
        elevated={elevated}
        canRun={sasOk(snap) && levelAllows(tier, snap.consent.level, 'control')}
        supported={hasFeature(snap, 'playbooks')}
        onRun={(pb, args) => ctrl.runPlaybook(pb, args)}
        onCancel={(id) => void ctrl.cancelPlaybook(id)}
      />
    </Card>
  );
  const chatCard = (
    <Card>
      <ChatPanel items={snap.chat} peerName={peerName} peerTyping={snap.peerTyping} disabled={!secured} onSend={(t) => ctrl.sendChat(t)} onTyping={(a) => ctrl.setTyping(a)} />
    </Card>
  );
  // Phase F section 6.6: the phone camera (stream camera; renders nothing until then). The P3/P4 console has no
  // console recorder, so the camera is recorded only by the server recorder here (section 6.5a).
  const cameraSlot = <CameraSlot session={{ id: sessionId, live: snap.phase === 'live', consoleRecording: false }} sendChat={(t) => ctrl.sendChat(t)} tier={tier} />;
  const filesCard = (
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
  );
  const sasCard = (
    <Card>
      <SasHistory history={snap.sasHistory} />
    </Card>
  );
  const dialogs = (
    <>
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
    </>
  );

  if (mobile) {
    // Phase F section 7.4: the phone and tablet layouts; every panel of the desktop console stays reachable.
    const sections: ConsoleSection[] = [
      {
        id: 'view',
        label: 'View',
        content: (
          <>
            {inputMode}
            {monitorPicker}
            {navButtons}
            {touchToggles}
            {annotToolbar}
          </>
        ),
      },
      { id: 'chat', label: 'Chat', content: chatCard },
      { id: 'files', label: 'Files', content: filesCard },
      { id: 'keys', label: 'Keys', content: keysBar },
      {
        id: 'more',
        label: 'More',
        content: (
          <>
            {statsCard}
            {voiceCard}
            {policyCard}
            {clipboardCard}
            {playbookCard}
            {cameraSlot}
            {sasCard}
          </>
        ),
      },
    ];
    return (
      <>
        <MobileConsoleLayout
          layout={vp.layout as Exclude<typeof vp.layout, 'desktop'>}
          title={`Session with ${peerName}`}
          badges={
            <>
              {snap.sec.sas ? (
                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono dark:bg-slate-800" title={SAS_STOP_TEXT} data-testid="sas-header">
                  <span className="sr-only">Security code </span>
                  {sasDisplay(snap.sec.sas)}
                  {secured && !sasOk(snap) ? ' (not confirmed)' : ''}
                </span>
              ) : (
                <Badge tone={snap.phase === 'live' ? 'green' : 'amber'}>{humanise(snap.phase)}</Badge>
              )}
              {device && <Badge tone={device.unattended ? 'amber' : 'blue'}>{device.unattended ? 'Unattended' : 'Attended'}</Badge>}
            </>
          }
          endLabel="End"
          onEnd={() => setConfirmEnd(true)}
          status={
            <>
              {statusLine}
              {alerts}
            </>
          }
          view={screen(null)}
          sections={sections}
          active={tab}
          onActive={(t) => {
            setTab(t);
            if (t === 'keys') setKeysOpen(true);
          }}
        />
        {dialogs}
      </>
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
        {device && <Badge tone={device.unattended ? 'amber' : 'blue'}>{device.unattended ? 'Unattended session' : 'Attended device session'}</Badge>}
        <div className="ml-auto flex gap-2">
          <Button variant="danger" onClick={() => setConfirmEnd(true)}>
            End session
          </Button>
        </div>
      </div>
      {statusLine}
      {alerts}
      <div className="grid gap-4 xl:grid-cols-[1fr_24rem]">
        <Card>
          <div className="mb-3 flex flex-col gap-2">
            {inputMode}
            {monitorPicker}
            {navButtons}
            {controlling && <p className="text-xs text-slate-600 dark:text-slate-400">Text is typed as you see it; shortcuts follow the user&apos;s keyboard layout. Hold Escape for 1 s to release the keyboard.</p>}
            {/* Phase F section 7.3: a touch screen at desktop width (a large tablet) gets the touch toggles and the keys bar. */}
            {vp.coarse && (
              <div className="flex flex-wrap items-center gap-2">
                {touchToggles}
                <Button size="sm" variant="secondary" aria-expanded={keysOpen} onClick={() => (keysOpen ? setKeysOpen(false) : openKeyboard())}>
                  {keysOpen ? 'Hide keyboard' : 'Keyboard'}
                </Button>
              </div>
            )}
            {vp.coarse && keysOpen && keysBar}
          </div>
          {screen(annotToolbar)}
        </Card>
        <div className="flex flex-col gap-4">
          {statsCard}
          {voiceCard}
          {policyCard}
          {clipboardCard}
          {playbookCard}
          {chatCard}
          {cameraSlot}
          {filesCard}
          {sasCard}
        </div>
      </div>
      {dialogs}
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
