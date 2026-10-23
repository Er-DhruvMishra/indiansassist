/** Desk room screens: waiting, consent, sharing, ended / receipt, errors (contracts section 12 / 12.1). */
import { useMemo } from 'react';
import { Link } from 'react-router';
import { CopyButton } from '../components/CopyButton';
import { DESK_SHORTCUTS } from '../components/ShortcutHelp';
import { Alert, Button, Spinner } from '../components/ui';
import { usePageTitle } from '../hooks/usePageTitle';
import { humanise } from '../lib/format';
import { readJoinBrand, type DeskBrand } from './brand';
import { ConsentScreen } from './ConsentScreen';
import type { DeskController, DeskSnapshot } from './deskController';
import { DeskLayout } from './DeskLayout';
import { Receipt } from './Receipt';
import { SharingView } from './SharingView';

const ERROR_TEXT: Record<string, string> = {
  token_busy: 'Another person is already in a session on this link.',
  token_gone: 'This link has expired, was already used, or was revoked.',
  token_not_found: 'This code is not valid, has already been used, or belongs to another region; use the full link or ask your technician for a new code.',
  token_malformed: 'This link is not a valid IndiansAssist link.',
  token_bad_signature: 'This link is not a valid IndiansAssist link.',
  region_mismatch: 'This organisation is hosted in another region; open the link on that region\'s site.',
  join_unsupported: 'The IndiansAssist client for this package is not available yet.',
};

function WaitingScreen({ snap, token, brand }: { snap: DeskSnapshot; token: string; brand: DeskBrand | null }) {
  const tech = snap.hello?.technician?.name;
  return (
    <DeskLayout brand={brand}>
      <h1 className="mb-3 text-2xl font-semibold">{tech ? `Waiting for ${tech} to accept` : 'Waiting for your technician'}</h1>
      <div role="status" aria-live="polite" className="mb-4 flex flex-col gap-2 text-sm">
        {snap.phase === 'connecting' && <Spinner label="Connecting" />}
        {snap.phase === 'held' && <Alert tone="amber">Your technician is not online yet, this page keeps trying.</Alert>}
        {snap.phase === 'waiting' && <Spinner label="Your request was sent. Keep this tab open." />}
        {snap.signalStatus === 'reconnecting' && <Alert tone="amber">Connection lost, reconnecting...</Alert>}
        {snap.notice && <p>{snap.notice}</p>}
      </div>
      <p className="mb-3 text-sm text-slate-700 dark:text-slate-300">Nothing is shared until you choose to share on the next screen.</p>
      <CopyButton text={token} label="Copy token again" variant="secondary" />
    </DeskLayout>
  );
}

function EndedPlain({ ctrl, snap, brand }: { ctrl: DeskController; snap: DeskSnapshot; brand: DeskBrand | null }) {
  const reason = snap.ended?.endReason;
  const canRetry = reason === 'denied' || reason === 'timeout';
  const text =
    reason === 'denied'
      ? 'Your technician declined the request.'
      : reason === 'timeout'
        ? 'Your technician did not answer.'
        : reason === 'consent_revoked'
          ? 'You declined. Nothing was shared.'
          : `The session ended (${humanise(reason ?? 'ended')}). Nothing was shared.`;
  return (
    <DeskLayout brand={brand}>
      <h1 className="mb-3 text-2xl font-semibold">Session ended</h1>
      <p className="mb-4" role="status">{text}</p>
      {snap.notice && <Alert tone="amber">{snap.notice}</Alert>}
      <div className="flex gap-2">
        {canRetry && snap.signalStatus === 'open' && <Button onClick={() => ctrl.tryAgain()}>Try again</Button>}
        <Link to="/join" className="inline-flex min-h-10 items-center rounded-md border border-slate-400 px-4 text-sm font-medium">
          Use another link
        </Link>
      </div>
    </DeskLayout>
  );
}

export function RoomScreen({ ctrl, snap, token }: { ctrl: DeskController; snap: DeskSnapshot; token: string }) {
  // D7: the document title is prefixed "(Sharing) " while sharing.
  usePageTitle(snap.phase === 'sharing' ? '(Sharing) Support session' : 'Support session');
  // prd-F3: the org's branding from the join lookup until the server's copy arrives.
  const joinBrand = useMemo(() => readJoinBrand(), []);
  const brand: DeskBrand | null = snap.created?.org ?? snap.hello?.org ?? joinBrand;
  switch (snap.phase) {
    case 'connecting':
    case 'waiting':
    case 'held':
      return <WaitingScreen snap={snap} token={token} brand={brand} />;
    case 'consent':
    case 'picking':
    case 'starting':
      return <ConsentScreen ctrl={ctrl} snap={snap} />;
    case 'sharing':
      return <SharingView ctrl={ctrl} snap={snap} />;
    case 'ending':
      return (
        <DeskLayout brand={brand}>
          <Spinner label="Stopping. All sharing has already stopped on this computer." />
        </DeskLayout>
      );
    case 'ended':
      return snap.ended?.reachedActive ? <Receipt snap={snap} brand={brand} /> : <EndedPlain ctrl={ctrl} snap={snap} brand={brand} />;
    case 'error':
    default:
      return (
        <DeskLayout shortcuts={DESK_SHORTCUTS} brand={brand}>
          <h1 className="mb-3 text-2xl font-semibold">Cannot join this session</h1>
          <Alert>{(snap.error && ERROR_TEXT[snap.error.code]) ?? snap.error?.message ?? 'The connection was closed.'}</Alert>
          <Link to="/join" className="mt-4 inline-block font-medium text-teal-800 underline dark:text-teal-300">
            Enter another code or link
          </Link>
        </DeskLayout>
      );
  }
}
