/**
 * /c and /c/:code (docs/specs/phase-f-contracts.md section 6.3, stream camera): the phone page that joins a live
 * session as a camera after explicit consent. `/c` asks for the code first (W104: anyone can type it). Nothing is
 * captured before **Start camera**; the page sets no cookie and stores nothing; it says first whether the camera will
 * be recorded (section 6.5a).
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { formatCameraCode, normaliseCameraCode } from '@indiansassist/shared';
import { Alert, Button, Field, Input, Spinner } from '../components/ui';
import { ASSIST_SIGNAL_URL } from '../config';
import { usePageTitle } from '../hooks/usePageTitle';
import { PublicLayout } from '../pages/PublicLayout';
import { CameraPhoneController, type PhoneDeps } from './cameraPhone';

/** Tests inject fakes here (WebSocket, peer connection, getUserMedia). */
let depsOverride: Partial<PhoneDeps> | null = null;
export function setCameraPhoneDeps(d: Partial<PhoneDeps> | null): void {
  depsOverride = d;
}

export function CameraJoinPage() {
  usePageTitle('Phone camera');
  const params = useParams<{ code?: string }>();
  const fromLink = params.code ? normaliseCameraCode(params.code) : null;
  const [typed, setTyped] = useState<string | null>(null);
  const code = fromLink ?? typed;
  if (params.code && !fromLink)
    return (
      <PublicLayout title="Phone camera">
        <Alert>
          This camera link is not complete. Ask the technician for the code and type it at the address ending in /c.
        </Alert>
      </PublicLayout>
    );
  if (!code) return <CodeEntry onCode={setTyped} />;
  return <CameraSession key={code} code={code} />;
}

function CodeEntry({ onCode }: { onCode: (code: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = normaliseCameraCode(value);
    if (!c) return setError('Type the 12 characters the technician gave you, for example ABCD-EFGH-JKMN.');
    onCode(c);
  };
  return (
    <PublicLayout title="Show the technician your camera">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Camera code" hint="12 letters and numbers from the technician" error={error}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={20}
            />
          )}
        </Field>
        <Button type="submit" size="lg">
          Continue
        </Button>
      </form>
    </PublicLayout>
  );
}

function CameraSession({ code }: { code: string }) {
  const ctrl = useMemo(
    () => new CameraPhoneController(code, { signalUrl: ASSIST_SIGNAL_URL, ...(depsOverride ?? {}) }),
    [code],
  );
  useEffect(() => {
    ctrl.connect();
    return () => ctrl.dispose();
  }, [ctrl]);
  const snap = useSyncExternalStore(ctrl.subscribe, () => ctrl.snapshot);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const stream = ctrl.preview;
    if (v.srcObject !== stream) v.srcObject = stream;
  }, [ctrl, snap.phase, snap.facing, snap.capture]);

  const tech = snap.technician ?? 'The technician';
  const org = snap.org ?? 'your support provider';
  const recorded = snap.recording.server || snap.recording.console;

  return (
    <PublicLayout title={snap.phase === 'live' ? 'Sharing your camera' : 'Phone camera'}>
      <p role="status" aria-live="polite" className="sr-only">
        {statusText(snap.phase, tech)}
      </p>
      {snap.phase === 'connecting' && <Spinner label="Connecting to the support session" />}

      {snap.phase === 'consent' && (
        <div className="flex flex-col gap-4">
          <p className="text-lg font-semibold">{org}</p>
          <p>
            {tech} from {org} asks to see what your phone's camera shows, live, during your support session.
          </p>
          <p>Only the camera is shared: not your screen, microphone, photos or location.</p>
          <p className={recorded ? 'font-medium' : undefined}>
            {recorded
              ? `This support session is being recorded under ${org}'s policy, so the camera will be recorded too.`
              : 'The camera is not recorded.'}
          </p>
          <p>
            The technician can take still pictures, which are noted in the session's audit log by a fingerprint. You can
            stop at any time.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button size="lg" onClick={() => void ctrl.start()}>
              Start camera
            </Button>
            <Button size="lg" variant="secondary" onClick={() => ctrl.decline()}>
              No thanks
            </Button>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400">Code {formatCameraCode(code)}</p>
        </div>
      )}

      {snap.phase === 'starting' && <Spinner label="Starting the camera" />}

      {snap.phase === 'live' && (
        <div className="flex flex-col gap-3">
          <div className="rounded-md bg-teal-800 px-3 py-2 text-sm font-medium text-white" role="note">
            Your camera is being shared with {tech}
          </div>
          {recorded && (
            <div className="rounded-md bg-red-700 px-3 py-2 text-sm font-medium text-white" role="note">
              Recording: this camera is being recorded under {org}'s policy
            </div>
          )}
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            aria-label="What your camera is sharing"
            className="aspect-video w-full rounded-md bg-black object-contain"
          />
          <p className="text-sm">
            {snap.securityCode ? (
              <>
                Camera code <span className="font-mono text-lg font-semibold">{snap.securityCode}</span>. Read it to the
                technician: it must match the code on their screen.
              </>
            ) : (
              'Checking the connection...'
            )}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Button size="lg" variant="secondary" onClick={() => void ctrl.switchCamera()}>
              Switch camera
            </Button>
            {snap.torch.available && (
              <Button
                size="lg"
                variant="secondary"
                aria-pressed={snap.torch.on}
                onClick={() => void ctrl.toggleTorch()}
              >
                {snap.torch.on ? 'Light off' : 'Light'}
              </Button>
            )}
            <Button size="lg" variant="danger" className="col-span-2" onClick={() => ctrl.stop('phone_stopped')}>
              Stop
            </Button>
          </div>
        </div>
      )}

      {(snap.phase === 'ended' || snap.phase === 'invalid') && (
        <Alert tone={snap.phase === 'invalid' || snap.endedReason === 'error' ? 'red' : 'blue'}>{snap.message}</Alert>
      )}
    </PublicLayout>
  );
}

function statusText(phase: string, tech: string): string {
  switch (phase) {
    case 'connecting':
      return 'Connecting to the support session';
    case 'consent':
      return `${tech} asks to see your camera`;
    case 'starting':
      return 'Starting the camera';
    case 'live':
      return `Your camera is being shared with ${tech}`;
    default:
      return 'The camera is not shared';
  }
}
