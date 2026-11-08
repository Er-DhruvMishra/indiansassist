/**
 * /join for a `p2_extension` token (Phase B 2.1 J1-J7): detect the extension, then **Open in extension** (in-process
 * handshake, no clipboard write) or **Install the extension** (copy the code, open the store listing). Always:
 * **Copy token** and the collapsed developer install. Non-Chromium browsers get the "needs Chrome or Edge" notice.
 * Nothing is stored for the room and the page never navigates to /room for this tier.
 */
import { useEffect, useRef, useState } from 'react';
import { EXTENSION_ID_PLACEHOLDER, type PublicToken } from '@indiansassist/shared';
import { CopyButton } from '../components/CopyButton';
import { Alert, Badge, Button } from '../components/ui';
import { copyText } from '../lib/clipboard';
import { ExtensionLink, JOIN_ERROR_TEXT, isEdge, isNonChromium, type Detected, type RuntimeLike, type WindowLike } from './extensionHandshake';

export const NON_CHROMIUM_TEXT = 'This package needs Chrome or Microsoft Edge on this computer. Ask your technician for a browser screen-share link instead.';
const BEACON_WAIT_MS = 1500;

type Env = { win: WindowLike; runtime: RuntimeLike | undefined; ua: string; hasChrome: boolean; brands?: { brand: string }[]; openTab: (url: string) => void };

function defaultEnv(): Env {
  const g = globalThis as unknown as { chrome?: { runtime?: RuntimeLike } };
  const nav = navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } };
  return {
    win: window,
    runtime: g.chrome?.runtime,
    ua: navigator.userAgent,
    hasChrome: g.chrome !== undefined,
    brands: nav.userAgentData?.brands,
    openTab: (url) => void window.open(url, '_blank', 'noopener,noreferrer'),
  };
}

type Phase = { k: 'idle' } | { k: 'sending' } | { k: 'ok'; state: string } | { k: 'failed'; text: string };

export function JoinP2({ info, code, accent, expired, env: envProp }: { info: PublicToken; code: string; accent: string; expired: boolean; env?: Env }) {
  const env = useRef(envProp ?? defaultEnv()).current;
  const [detected, setDetected] = useState<Detected | null>(null);
  const [beaconWaitOver, setBeaconWaitOver] = useState(false);
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [installNote, setInstallNote] = useState(false);
  const link = useRef<ExtensionLink | null>(null);
  const ext = info.extension ?? null;

  useEffect(() => {
    const l = new ExtensionLink({ win: env.win, runtime: env.runtime, ids: ext?.ids ?? [], onDetected: setDetected });
    link.current = l;
    l.start();
    const t = setTimeout(() => setBeaconWaitOver(true), BEACON_WAIT_MS);
    return () => {
      clearTimeout(t);
      l.stop();
    };
  }, [env, ext]);

  // J6: the user agent says Firefox / Safari, or there is no `window.chrome` at all and no beacon came within 1.5 s.
  const nonChromium = !detected && (isNonChromium(env.ua, true) || (beaconWaitOver && !env.hasChrome));
  const storeUrl = isEdge(env.brands) ? (ext?.edgeAddonsUrl ?? null) : (ext?.webStoreUrl ?? null);

  const open = async () => {
    if (!link.current) return;
    setPhase({ k: 'sending' });
    const r = await link.current.join(code);
    if (r.ok) return setPhase({ k: 'ok', state: r.state });
    await copyText(code).catch(() => undefined);
    setPhase({ k: 'failed', text: JOIN_ERROR_TEXT[r.error] ?? 'The extension could not start the session.' });
  };

  const install = async () => {
    await copyText(code).catch(() => undefined);
    if (storeUrl) env.openTab(storeUrl);
    setInstallNote(true);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="join-p2">
      <p className="text-sm">This session uses the IndiansAssist browser extension. Your technician will see the pages you choose to share, never your whole screen.</p>
      {nonChromium ? (
        <Alert tone="amber">{NON_CHROMIUM_TEXT}</Alert>
      ) : detected ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm">
            <Badge tone="green">Extension detected</Badge> <span className="text-xs text-slate-600 dark:text-slate-400">version {detected.version}</span>
          </p>
          {phase.k !== 'ok' && (
            <Button size="lg" onClick={() => void open()} disabled={expired || phase.k === 'sending'} style={!expired ? { backgroundColor: accent } : undefined}>
              {phase.k === 'sending' ? 'Opening...' : 'Open in extension'}
            </Button>
          )}
          {phase.k === 'ok' && (
            <Alert tone="green">
              {phase.state === 'already_connected' ? 'The extension is already connected to this session.' : 'Continue in the extension: your technician is being asked to accept. A window will then ask you what to share.'}
            </Alert>
          )}
          {phase.k === 'failed' && (
            <Alert>
              {phase.text} The code was copied: click the IndiansAssist icon in your toolbar and choose Paste from clipboard.
            </Alert>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {storeUrl ? (
            <Button size="lg" onClick={() => void install()} disabled={expired} style={!expired ? { backgroundColor: accent } : undefined}>
              Install the extension
            </Button>
          ) : (
            <Alert tone="amber">
              The extension is not in the browser stores yet. Get it from the{' '}
              <a href="/downloads" className="font-medium underline">
                downloads page
              </a>{' '}
              and follow the steps there, or use the developer install below.
            </Alert>
          )}
          {installNote && <Alert tone="blue">Token copied. After installing, click the IndiansAssist icon in your toolbar and choose Paste from clipboard.</Alert>}
          <p className="text-xs text-slate-600 dark:text-slate-400">This page notices the extension as soon as it is installed; no reload is needed.</p>
        </div>
      )}
      <div>
        <CopyButton text={code} label="Copy token" againLabel="Copy token again" variant="secondary" />
      </div>
      <details className="rounded-md border border-slate-300 p-3 text-sm dark:border-slate-700">
        <summary className="cursor-pointer font-medium">Developer install (load unpacked)</summary>
        <ol className="mt-2 list-decimal pl-5">
          <li>Open chrome://extensions (or edge://extensions).</li>
          <li>Turn on Developer mode.</li>
          <li>Click Load unpacked and select apps/extension/dist.</li>
          <li>Reload this page.</li>
        </ol>
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
          Store listing until publication: https://chromewebstore.google.com/detail/{ext?.ids[0] ?? EXTENSION_ID_PLACEHOLDER}
        </p>
      </details>
    </div>
  );
}
