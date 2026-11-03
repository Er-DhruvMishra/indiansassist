/**
 * The phone camera panel of the console (docs/specs/phase-f-contracts.md section 6.6, stream camera), rendered by the
 * foundation's `<CameraSlot/>` in `LiveConsole` (P1) and `AgentConsole` (P3/P4). The link step (QR, link, code, expiry
 * countdown, **Send to the Desk's chat**, **Cancel link**), then the live video in a resizable pane with the camera
 * code, **Freeze** / **Resume**, **Snapshot** (a PNG download whose sha256 is chained) and **Stop camera**. States are
 * words, every control is reachable by keyboard and the video is labelled as the phone camera.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { formatCameraCode } from '@indiansassist/shared';
import type { CameraSlotProps } from '../assist/console/PhaseFSlots';
import { useAssistSignal } from '../assist/signal/AssistSignalProvider';
import { CopyButton } from '../components/CopyButton';
import { QrCode } from '../components/QrCode';
import { Alert, Badge, Button, Card } from '../components/ui';
import { useNow } from '../hooks/useAsync';
import type { SignalClient } from '../lib/signal';
import {
  cameraChatText,
  ConsoleCameraController,
  endedWords,
  snapshotFileName,
  type ConsoleCameraDeps,
} from './cameraConsole';

/** Tests inject fakes here (camera API, peer connection, MediaRecorder). */
let depsOverride: Partial<ConsoleCameraDeps> | null = null;
export function setCameraConsoleDeps(d: Partial<ConsoleCameraDeps> | null): void {
  depsOverride = d;
}

export function CameraPanel({ session, sendChat, tier }: CameraSlotProps) {
  const signal = useAssistSignal()?.client ?? null;
  if (tier === 'p2_extension') return null; // section 6.2d: no camera in P2 (PRD 4)
  return (
    <CameraPanelView
      key={`${session.id}:${signal ? 'on' : 'off'}`}
      session={session}
      sendChat={sendChat}
      signal={signal}
    />
  );
}

function CameraPanelView({
  session,
  sendChat,
  signal,
}: Omit<CameraSlotProps, 'tier'> & { signal: SignalClient | null }) {
  const ctrl = useMemo(
    () => new ConsoleCameraController({ sessionId: session.id, signal, ...(depsOverride ?? {}) }),
    [session.id, signal],
  );
  useEffect(() => {
    const detach = ctrl.attach();
    return () => {
      detach();
      ctrl.dispose();
    };
  }, [ctrl]);
  useEffect(() => ctrl.setConsoleRecording(session.consoleRecording), [ctrl, session.consoleRecording]);
  const snap = useSyncExternalStore(ctrl.subscribe, () => ctrl.snapshot);
  const [frozen, setFrozen] = useState(false);
  const [sent, setSent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frozenRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (v && v.srcObject !== ctrl.stream) v.srcObject = ctrl.stream;
  }, [ctrl, snap.hasVideo, snap.phase]);
  useEffect(() => {
    if (snap.phase !== 'live') setFrozen(false);
    if (snap.phase === 'idle' || snap.phase === 'creating') setSent(false);
  }, [snap.phase]);

  const live = snap.phase === 'live';
  const linked = snap.phase === 'linked';

  const freeze = () => {
    const v = videoRef.current;
    const c = frozenRef.current;
    if (!v || !c) return;
    c.width = v.videoWidth || 1280;
    c.height = v.videoHeight || 720;
    c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
    setFrozen(true);
  };

  const snapshot = async () => {
    const v = videoRef.current;
    const src = frozen ? frozenRef.current : null;
    const width = src ? src.width : v?.videoWidth || 0;
    const height = src ? src.height : v?.videoHeight || 0;
    if (!width || !height) return setNotice('No camera picture yet.');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    if (!g) return setNotice('This browser cannot take a snapshot.');
    if (src) g.drawImage(src, 0, 0);
    else if (v) g.drawImage(v, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) return setNotice('The snapshot could not be made.');
    const name = snapshotFileName(session.id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    try {
      const sha = await ctrl.recordSnapshot(blob, width, height);
      setNotice(`Snapshot saved as ${name} and noted in the audit log (fingerprint ${sha.slice(0, 12)}...).`);
    } catch {
      setNotice(`Snapshot saved as ${name}, but it could not be noted in the audit log.`);
    }
  };

  return (
    <Card
      title="Phone camera"
      actions={
        live || snap.phase === 'joined' ? (
          <Badge tone={live ? 'green' : 'neutral'}>{stateWords(snap.phase, frozen)}</Badge>
        ) : undefined
      }
    >
      <p className="sr-only" role="status" aria-live="polite">
        {stateWords(snap.phase, frozen, snap.endedReason)}
      </p>
      {snap.error && <Alert>{snap.error}</Alert>}

      {(snap.phase === 'idle' || snap.phase === 'ended') && (
        <div className="flex flex-col gap-2">
          {snap.phase === 'ended' && <p className="text-sm">{endedWords(snap.endedReason)}</p>}
          <p className="text-sm text-slate-700 dark:text-slate-300">
            Ask the person to show you something with their phone's camera. They open a link or scan a code; nothing is
            shared until they agree on the phone.
          </p>
          <div>
            <Button variant="secondary" disabled={!session.live} onClick={() => void ctrl.createLink()}>
              {snap.phase === 'ended' ? 'New phone camera link' : 'Phone camera'}
            </Button>
          </div>
          {!session.live && (
            <p className="text-xs text-slate-600 dark:text-slate-400">Available while the session is live.</p>
          )}
        </div>
      )}

      {snap.phase === 'creating' && <p className="text-sm">Creating the camera link...</p>}

      {(linked || snap.phase === 'joined') && snap.link && (
        <LinkStep
          link={snap.link}
          joined={snap.phase === 'joined'}
          sent={sent}
          onSend={() => {
            sendChat(cameraChatText(snap.link!));
            setSent(true);
          }}
          onCancel={() => void ctrl.stop()}
        />
      )}

      {live && (
        <div className="flex flex-col gap-3">
          <div
            className="relative min-h-40 resize overflow-hidden rounded-md bg-black"
            style={{ width: '100%', aspectRatio: '16 / 9' }}
          >
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              aria-label="Phone camera, live video from the person's phone"
              className={frozen ? 'hidden' : 'h-full w-full object-contain'}
            />
            <canvas
              ref={frozenRef}
              aria-label="Phone camera, frozen picture"
              className={frozen ? 'h-full w-full object-contain' : 'hidden'}
            />
            <span className="absolute left-2 top-2 rounded bg-slate-900/80 px-2 py-0.5 text-xs font-semibold text-white">
              {frozen ? 'Frozen' : 'Live'}
            </span>
            {snap.recording === 'recording' && (
              <span className="absolute right-2 top-2 rounded bg-red-700 px-2 py-0.5 text-xs font-semibold text-white">
                Recording
              </span>
            )}
          </div>
          {!snap.hasVideo && <p className="text-sm">Waiting for the phone's video...</p>}
          <div className="text-sm">
            {snap.securityCode ? (
              <>
                Camera code <span className="font-mono text-base font-semibold">{snap.securityCode}</span>. Ask the
                person to read the code on their phone; it must match.
              </>
            ) : (
              'Checking the camera connection...'
            )}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={snap.codesConfirmed}
              disabled={!snap.securityCode}
              onChange={(e) => ctrl.confirmCodes(e.target.checked)}
            />
            Codes match
          </label>
          {!snap.codesConfirmed && (
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              Camera code not confirmed. If the codes differ, stop the camera.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={!snap.hasVideo}
              onClick={() => (frozen ? setFrozen(false) : freeze())}
            >
              {frozen ? 'Resume' : 'Freeze'}
            </Button>
            <Button variant="secondary" disabled={!snap.hasVideo} onClick={() => void snapshot()}>
              Snapshot
            </Button>
            <Button variant="danger" onClick={() => void ctrl.stop()}>
              Stop camera
            </Button>
          </div>
          {snap.recording === 'uploading' && <p className="text-sm">Uploading the camera recording...</p>}
          {snap.recording === 'stored' && <p className="text-sm">The camera recording was stored.</p>}
          {notice && (
            <p className="text-sm" role="status">
              {notice}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function LinkStep({
  link,
  joined,
  sent,
  onSend,
  onCancel,
}: {
  link: { url: string; code: string; expiresAt: string };
  joined: boolean;
  sent: boolean;
  onSend: () => void;
  onCancel: () => void;
}) {
  const now = useNow(1000);
  const left = Math.max(0, Math.floor((new Date(link.expiresAt).getTime() - now) / 1000));
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, '0');
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">{joined ? 'Phone connected, waiting for consent' : 'Waiting for the phone'}</p>
      {!joined && (
        <>
          <QrCode text={link.url} label="QR code of the phone camera link" size={160} />
          <p className="break-all text-sm">
            <span className="font-medium">Link</span> {link.url}
          </p>
          <p className="text-sm">
            <span className="font-medium">Code</span> <span className="font-mono">{formatCameraCode(link.code)}</span>
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {left > 0 ? `The link expires in ${mm}:${ss}.` : 'The link has expired.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={onSend}>{sent ? "Sent to the Desk's chat" : "Send to the Desk's chat"}</Button>
            <CopyButton text={link.url} label="Copy link" variant="secondary" />
          </div>
        </>
      )}
      <div>
        <Button variant="ghost" onClick={onCancel}>
          Cancel link
        </Button>
      </div>
    </div>
  );
}

function stateWords(phase: string, frozen: boolean, reason?: Parameters<typeof endedWords>[0]): string {
  switch (phase) {
    case 'linked':
      return 'Waiting for the phone';
    case 'joined':
      return 'Phone connected, waiting for consent';
    case 'live':
      return frozen ? 'Frozen' : 'Live';
    case 'ended':
      return endedWords(reason ?? null);
    default:
      return '';
  }
}
