/**
 * The P2 console (Phase B 10): tab strip (top), replayer host (centre), control rail (right), status. Mounted by
 * the session route instead of the video console when `session.created.tier === 'p2_extension'`. Chat, voice,
 * files and End session are the Phase A panels unchanged; the network panel shows the mirror channel instead of
 * video. Level, scope and background-tab consent come from `consent.changed` only.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { effectiveMaxLevel, levelAtLeast, type ConsentLevel, type ControlOp, type SessionCreated } from '@indiansassist/shared';
import { useAuth } from '../../../auth/AuthContext';
import { Dialog } from '../../../components/Dialog';
import { ReasonDialog } from '../../../components/ReasonDialog';
import { Alert, Badge, Button, Card, Spinner } from '../../../components/ui';
import { useAsync } from '../../../hooks/useAsync';
import { sessionsApi } from '../../../lib/endpoints';
import { humanise } from '../../../lib/format';
import type { SignalClient } from '../../../lib/signal';
import { EndedView, RecordingCard } from '../EndedView';
import { BackstagePanel } from './BackstagePanel';
import { LEVEL_LABEL, clampMode, type InputMode } from './controlBuilders';
import { InputModeToggle } from './InputModeToggle';
import { MaskIndicator } from './MaskIndicator';
import { MirrorConsoleController, type MirrorSnapshot } from './mirrorController';
import { placeholderFor } from './mirrorState';
import { MirrorSidePanels } from './MirrorSidePanels';
import { ReplayerHost } from './ReplayerHost';
import { TabControlPanel } from './TabControlPanel';
import { TabStrip, tabTitle } from './TabStrip';

const PHASE_TEXT: Record<string, string> = {
  resuming: 'Reconnecting to the session...',
  waiting_consent: 'Waiting for consent. The user is choosing what to share in the extension.',
  connecting: 'Consent granted. Connecting to the browser extension...',
  live: 'Live',
  reconnecting: 'The connection was interrupted. Reconnecting...',
  ending: 'Ending the session...',
  ended: 'Session ended',
};

const MODE_FOR: Record<ConsentLevel, InputMode> = { view: 'view', tab_control: 'tab', in_page: 'in_page', deep_control: 'deep' };

export function MirrorLiveConsole({ sessionId, signal, cached, helloReady, deskLabel }: { sessionId: string; signal: SignalClient; cached: SessionCreated | undefined; helloReady: boolean; deskLabel: string }) {
  const { me } = useAuth();
  const [ctrl, setCtrl] = useState<MirrorConsoleController | null>(null);
  const startArgs = useRef({ cached, helloReady, assist: { id: me?.user.id ?? '', name: me?.user.name ?? '' } });
  useEffect(() => {
    const c = new MirrorConsoleController({ signal, sessionId, assist: startArgs.current.assist });
    c.start(startArgs.current.cached, startArgs.current.helloReady);
    setCtrl(c);
    return () => c.dispose();
  }, [signal, sessionId]);
  if (!ctrl) return <Spinner label="Opening the console" />;
  return <MirrorConsoleView key={sessionId} ctrl={ctrl} sessionId={sessionId} signal={signal} deskLabel={deskLabel} />;
}

export function MirrorConsoleView({ ctrl, sessionId, signal, deskLabel }: { ctrl: MirrorConsoleController; sessionId: string; signal: SignalClient; deskLabel: string }) {
  const { me } = useAuth();
  const snap: MirrorSnapshot = useSyncExternalStore(ctrl.subscribe, () => ctrl.snapshot);
  const plane = ctrl.plane;
  const [asking, setAsking] = useState<ConsentLevel | null>(null);
  const [pendingLevel, setPendingLevel] = useState<ConsentLevel | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [followFocus, setFollowFocus] = useState(false);
  const fsRef = useRef<HTMLDivElement>(null);
  const onFrame = useCallback((f: HTMLIFrameElement | null) => plane.attachFrame(f), [plane]);

  const level = snap.level;
  const max = effectiveMaxLevel(snap.policy);
  const canTab = level !== null && levelAtLeast(level, 'tab_control');
  const live = snap.phase === 'live' || snap.phase === 'connecting' || snap.phase === 'reconnecting';
  const peerName = snap.created?.desk.label ?? deskLabel;
  const focused = snap.tabs.tabs.find((t) => t.tabId === snap.tabs.focusedTabId) ?? null;
  const view = focused ? snap.tabs.views[focused.tabId] : undefined;
  const placeholder = snap.phase === 'waiting_consent' ? 'Waiting for the user to choose what to share.' : placeholderFor(view, focused ? snap.tabs.tooLargeOnRelay[focused.tabId] === true : false);

  // The toggle follows the granted level: a lowered level steps the selected mode down (section 3.2).
  useEffect(() => {
    const clamped = clampMode(snap.inputMode, level);
    if (clamped !== snap.inputMode) plane.setInputMode(clamped);
  }, [level, snap.inputMode, plane]);

  const detail = useAsync(() => (snap.phase === 'ended' ? sessionsApi.get(sessionId) : Promise.resolve(null)), [snap.phase, sessionId]);

  const onOp = useCallback((op: ControlOp, args: Record<string, unknown>, okText?: string) => plane.op(op, args, okText ? { okText } : {}), [plane]);

  const focusTab = (tabId: number) => {
    plane.focus(tabId);
    const t = snap.tabs.tabs.find((x) => x.tabId === tabId);
    if (followFocus && canTab && t && !t.backstage) void plane.op('tabs.activate', { tabId }, { quiet: true });
  };

  const sendLevelRequest = async (lvl: ConsentLevel, reason: string) => {
    setAsking(null);
    setPendingLevel(lvl);
    const r = await plane.op('level.request', { level: lvl, reason }, { okText: `The user allowed: ${LEVEL_LABEL[lvl]}.` });
    setPendingLevel(null);
    if (r.ok) plane.setInputMode(MODE_FOR[lvl]);
  };

  if (snap.phase === 'ended') {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="blue">Session ended{snap.ended ? `: ${humanise(snap.ended.endReason)}` : ''}. The mirror was closed.</Alert>
        {detail.loading && <Spinner label="Loading session record" />}
        {detail.data && (
          <EndedView detail={detail.data} recording={{ phase: snap.recording, failure: snap.recordingFailure, progress: snap.uploadProgress, result: snap.recordingResult, onRetry: () => void ctrl.retryUpload() }} />
        )}
      </div>
    );
  }

  const revealUntil = focused ? (snap.revealUntil[focused.tabId] ?? null) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Browser session with {peerName}</h1>
        <Badge tone={snap.phase === 'live' ? 'green' : 'amber'}>{humanise(snap.phase)}</Badge>
        {level && <Badge tone="blue">{LEVEL_LABEL[level]}</Badge>}
        {snap.scope && <Badge>{snap.scope === 'all_tabs' ? 'All tabs' : 'One tab'}</Badge>}
        {snap.debuggerTabs.length > 0 && <Badge tone="red">Deep control on</Badge>}
        {snap.recording === 'recording' && <Badge tone="red">Recording</Badge>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {snap.recording === 'recording' ? (
            <Button variant="danger" size="sm" aria-pressed="true" onClick={() => void ctrl.stopRecording()}>
              Stop recording
            </Button>
          ) : (
            <Button variant="secondary" size="sm" aria-pressed="false" disabled={!live || snap.recordingUsed} onClick={() => ctrl.startRecording()} title="Records the mirrored pages (no voice)">
              Record
            </Button>
          )}
          <Button variant="danger" onClick={() => setConfirmEnd(true)}>
            End session
          </Button>
        </div>
      </div>
      <p className="text-sm" role="status" aria-live="polite">
        {PHASE_TEXT[snap.phase]} {snap.notice ?? ''}
      </p>
      {snap.error && <Alert>{snap.error}</Alert>}
      {snap.lastOp && (
        <p role="status" aria-live="polite" data-testid="op-notice" className={snap.lastOp.ok ? 'text-sm text-green-800 dark:text-green-300' : 'text-sm text-red-800 dark:text-red-300'}>
          {snap.lastOp.text}
        </p>
      )}
      {snap.unreported > 0 && <Alert tone="amber">{snap.unreported} requests not reported to the audit trail.</Alert>}
      <div className="grid gap-4 xl:grid-cols-[1fr_24rem]">
        <Card>
          <div className="mb-3 flex flex-col gap-3">
            <TabStrip state={snap.tabs} onFocus={focusTab} onFollow={focusTab} />
            <div className="flex flex-wrap items-center gap-3">
              <InputModeToggle mode={snap.inputMode} granted={level} max={max} pendingLevel={pendingLevel} onSelect={(m) => plane.setInputMode(m)} onAsk={(l) => setAsking(l)} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={followFocus} disabled={!canTab} onChange={(e) => setFollowFocus(e.target.checked)} />
                Follow my focus on the Desk
              </label>
            </div>
          </div>
          <ReplayerHost
            title={focused ? tabTitle(focused) : 'none'}
            placeholder={placeholder}
            stale={snap.stale}
            frameHint={snap.frameHint}
            armed={snap.armed}
            watermark={{ name: me?.user.name ?? '', userId: me?.user.id ?? '', sessionId }}
            onFrame={onFrame}
            fullscreenRef={fsRef}
          />
          <p className="sr-only" aria-live="polite">
            {focused ? `Viewing ${tabTitle(focused)}. ${placeholder ?? ''}` : ''}
          </p>
        </Card>
        <div className="flex flex-col gap-4">
          {snap.recording !== 'idle' && snap.recording !== 'recording' && (
            <RecordingCard recordingId={snap.recordingResult?.id ?? null} phase={snap.recording} failure={snap.recordingFailure} progress={snap.uploadProgress} result={snap.recordingResult} onRetry={() => void ctrl.retryUpload()} />
          )}
          <Card>
            <MaskIndicator
              masked={snap.mask.masked}
              revealUntil={revealUntil}
              armed={snap.armed === 'reveal'}
              allowUnmask={snap.policy.allowUnmask}
              recording={snap.recording === 'recording'}
              recordRevealed={snap.policy.recordRevealed}
              disabled={!focused || view !== 'live'}
              onRevealTab={() => focused && plane.setRevealTarget({ tabId: focused.tabId, scope: 'tab' })}
              onArm={(on) => plane.armReveal(on)}
            />
          </Card>
          <Card>
            <TabControlPanel tab={focused} canTab={canTab} onOp={onOp} />
          </Card>
          <Card>
            <BackstagePanel tabs={snap.tabs.tabs} canTab={canTab} consented={snap.backstage} orgAllows={snap.policy.backstageAllowed} onOp={onOp} />
          </Card>
          <MirrorSidePanels ctrl={ctrl} snap={snap} signal={signal} peerName={peerName} live={live} />
        </div>
      </div>
      <ReasonDialog
        open={asking !== null}
        title="Ask the user for more control"
        description={asking ? `Ask ${peerName} to allow: ${LEVEL_LABEL[asking]}.` : ''}
        onClose={() => setAsking(null)}
        onSubmit={(r) => asking && void sendLevelRequest(asking, r)}
      />
      <ReasonDialog
        open={snap.revealTarget !== null}
        title={snap.revealTarget?.scope === 'tab' ? 'Ask to reveal this tab' : 'Ask to reveal this field'}
        description={snap.revealTarget?.scope === 'tab' ? 'All hidden fields on this tab (never passwords) are shown for up to 60 seconds if the user agrees.' : 'The field is shown for up to 60 seconds if the user agrees, and hidden again when they leave it.'}
        submitLabel="Ask the user"
        onClose={() => plane.setRevealTarget(null)}
        onSubmit={(r) => snap.revealTarget && void plane.requestReveal(snap.revealTarget, r)}
      />
      <ConfirmEnd open={confirmEnd} onClose={() => setConfirmEnd(false)} onEnd={() => void ctrl.endSession()} />
    </div>
  );
}

function ConfirmEnd({ open, onClose, onEnd }: { open: boolean; onClose: () => void; onEnd: () => void }) {
  return (
    <Dialog open={open} title="End this session?" onClose={onClose}>
      <p className="mb-4 text-sm">Sharing stops for the user immediately. A running recording is stopped and uploaded.</p>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Keep session
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            onClose();
            onEnd();
          }}
        >
          End session
        </Button>
      </div>
    </Dialog>
  );
}
