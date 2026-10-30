/**
 * /join for a `p3_portable` token (docs/specs/phase-c-contracts.md section 2.7 J1-J6). Windows: **Download
 * IndiansAssist** through the grant flow (`POST /download/prepare`, then a programmatic `<a download>`); the page
 * writes nothing to the clipboard on its own; **Copy support code** copies the per-download desk code only; ARM64
 * link; sha256 / version and the signed line; **Download again** after a `410`; deep link only after Keep (L3) or on
 * **I already have IndiansAssist**. Android: the App Link, then **Get the app**, **Copy token** and a QR. iOS: text.
 * Nothing is stored for the room and the page never navigates to /room for this tier.
 */
import { useEffect, useRef, useState } from 'react';
import type { AgentArch, AgentPlatform, DownloadPrepareReply, PublicToken } from '@indiansassist/shared';
import { CopyButton } from '../components/CopyButton';
import { QrCode } from '../components/QrCode';
import { Alert, Button } from '../components/ui';
import { downloadApi } from '../lib/agentApi';
import { errorMessage, isApiError } from '../lib/api';
import { readStore } from '../lib/storage';
import {
  AGENT_SEEN_KEY,
  DEEP_LINK_WAIT_MS,
  browserDeepLinkEnv,
  clickDownload,
  deepLinkFor,
  detectPlatform,
  groupCode,
  joinLinkFor,
  tryDeepLink,
  type DeepLinkEnv,
} from './agentDownload';

export const P3_INTRO = 'This session uses the IndiansAssist support client. It runs without installing anything and removes itself when you close it.';
export const P3_UNAVAILABLE = 'The support client is not available on this server; ask your technician for a browser screen-share link instead.';
export const P3_IOS = 'Android only for now; ask your technician for a browser screen-share link.';

export type JoinP3Env = {
  nav: { userAgent: string; userAgentData?: { platform?: string } };
  origin: string;
  deepLink: DeepLinkEnv;
  storage: Pick<Storage, 'getItem'>;
  download: (url: string, filename: string) => void;
  /** HEAD of a grant URL (uncounted): the status, 0 on a network error. */
  probe: (url: string) => Promise<number>;
  prepare: (code: string, platform: AgentPlatform, arch: AgentArch) => Promise<DownloadPrepareReply>;
  setTimeout: (cb: () => void, ms: number) => unknown;
};

function defaultEnv(): JoinP3Env {
  return {
    nav: navigator as JoinP3Env['nav'],
    origin: window.location.origin,
    deepLink: browserDeepLinkEnv(),
    storage: { getItem: (k) => readStore('local', k) },
    download: (url, name) => clickDownload(url, name),
    probe: (url) => fetch(url, { method: 'HEAD', credentials: 'omit' }).then((r) => r.status, () => 0),
    prepare: downloadApi.prepare,
    setTimeout: (cb, ms) => window.setTimeout(cb, ms),
  };
}

function prepareError(e: unknown): string {
  if (isApiError(e, 'download_unavailable')) return P3_UNAVAILABLE;
  if (isApiError(e, 'token_used')) return 'This code was already used for a session. Ask your technician for a new one.';
  if (isApiError(e, 'invalid_token_type')) return 'This code is not for the IndiansAssist support client.';
  return errorMessage(e);
}

export function JoinP3({ info, code, accent, expired, env: envProp }: { info: PublicToken; code: string; accent: string; expired: boolean; env?: Partial<JoinP3Env> }) {
  const env = useRef({ ...defaultEnv(), ...envProp } as JoinP3Env).current;
  const platform = detectPlatform(env.nav);
  const agent = info.agent ?? null;
  const seen = env.storage.getItem(AGENT_SEEN_KEY) === '1';
  const [prep, setPrep] = useState<DownloadPrepareReply | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDownload, setShowDownload] = useState(!seen);
  const [androidFallback, setAndroidFallback] = useState(false);
  const tried = useRef(false);
  const joinLink = joinLinkFor(env.origin, code);

  const openApp = async () => {
    const opened = await tryDeepLink(deepLinkFor(code), env.deepLink);
    if (!opened) setShowDownload(true);
  };

  useEffect(() => {
    // L3: the deep link is tried automatically only after the Desk chose Keep on this browser.
    if (tried.current || !seen || platform !== 'windows') return;
    tried.current = true;
    void openApp();
  }, []);

  const download = async (arch: AgentArch, p: AgentPlatform = 'windows') => {
    setBusy(true);
    setError(null);
    try {
      const r = await env.prepare(code, p, arch);
      setPrep(r);
      env.download(r.url, r.filename);
    } catch (e) {
      setError(prepareError(e));
    } finally {
      setBusy(false);
    }
  };

  const lastArch = useRef<{ arch: AgentArch; platform: AgentPlatform }>({ arch: 'x64', platform: 'windows' });
  const start = (a: AgentArch, p: AgentPlatform = 'windows') => {
    lastArch.current = { arch: a, platform: p };
    void download(a, p);
  };
  /** "Download again": the same grant while it still serves, else a fresh prepare (budget or TTL spent: 410). */
  const again = async () => {
    if (prep && (await env.probe(prep.url)) === 200) return env.download(prep.url, prep.filename);
    await download(lastArch.current.arch, lastArch.current.platform);
  };

  if (platform === 'ios') return <Alert tone="amber">{P3_IOS}</Alert>;

  if (platform === 'android') {
    const appUrl = agent?.android.appUrl ?? null;
    return (
      <div className="flex flex-col gap-3" data-testid="join-p3-android">
        <p className="text-sm">{P3_INTRO}</p>
        <a
          href={joinLink}
          className="inline-flex min-h-12 items-center justify-center rounded-md px-5 font-medium text-white"
          style={{ backgroundColor: accent }}
          onClick={() => env.setTimeout(() => setAndroidFallback(true), DEEP_LINK_WAIT_MS)}
        >
          Open in the IndiansAssist app
        </a>
        {androidFallback && (
          <div className="flex flex-col gap-2">
            {appUrl ? (
              <a href={appUrl} rel="noopener noreferrer" className="text-sm font-medium text-teal-800 underline dark:text-teal-300">
                Get the app
              </a>
            ) : agent?.android.apk ? (
              <Button variant="secondary" disabled={busy || expired} onClick={() => start('universal', 'android')}>
                Get the app
              </Button>
            ) : (
              <Alert tone="amber">{P3_UNAVAILABLE}</Alert>
            )}
          </div>
        )}
        {error && <Alert>{error}</Alert>}
        <div>
          <CopyButton text={code} label="Copy token" againLabel="Copy token again" variant="secondary" />
        </div>
        <QrCode text={joinLink} label="QR code of this join link for another device" size={176} />
      </div>
    );
  }

  const winAvailable = agent?.windows.x64 === true;
  return (
    <div className="flex flex-col gap-3" data-testid="join-p3">
      <p className="text-sm">{P3_INTRO}</p>
      {!winAvailable && <Alert tone="amber">{P3_UNAVAILABLE}</Alert>}
      {seen && (
        <Button size="lg" onClick={() => void openApp()} disabled={expired} style={!expired ? { backgroundColor: accent } : undefined}>
          Open IndiansAssist
        </Button>
      )}
      {winAvailable && showDownload && !prep && (
        <div className="flex flex-col gap-2">
          <Button size="lg" onClick={() => start('x64')} disabled={busy || expired} style={!expired ? { backgroundColor: accent } : undefined}>
            {busy ? 'Preparing your download...' : 'Download IndiansAssist'}
          </Button>
          {!seen && (
            <Button variant="secondary" onClick={() => void openApp()} disabled={expired}>
              I already have IndiansAssist
            </Button>
          )}
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      {prep && (
        <section aria-label="Your download" className="flex flex-col gap-2 rounded-md border border-slate-300 p-3 text-sm dark:border-slate-700">
          <p>
            Open the downloaded file <strong className="break-all">{prep.filename}</strong>; it connects on its own.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton text={prep.deskCode} label="Copy support code" againLabel="Copy support code again" variant="secondary" size="sm" />
            <span className="font-mono text-xs">{groupCode(prep.deskCode)}</span>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400">Use the support code only if the client asks for it.</p>
          <p className="text-xs" data-testid="p3-sha">
            Version {prep.version}, sha256 <span className="break-all font-mono">{prep.sha256}</span>
          </p>
          {prep.signed ? (
            <p className="text-xs">Signed by IndiansAssist.</p>
          ) : (
            <Alert tone="amber">This is an unsigned development build. Verify the file: its sha256 must equal the value above.</Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={busy || expired} onClick={() => void again()}>
              Download again
            </Button>
            {agent?.windows.arm64 && (
              <Button size="sm" variant="ghost" disabled={busy || expired} onClick={() => start('arm64')}>
                ARM64 version
              </Button>
            )}
          </div>
        </section>
      )}
      {winAvailable && !prep && agent?.windows.arm64 && showDownload && (
        <Button size="sm" variant="ghost" className="self-start" disabled={busy || expired} onClick={() => start('arm64')}>
          ARM64 version
        </Button>
      )}
      <details className="rounded-md border border-slate-300 p-3 text-sm dark:border-slate-700">
        <summary className="cursor-pointer font-medium">Join from another device</summary>
        <div className="mt-2">
          <QrCode text={joinLink} label="QR code of this join link for another device" size={176} />
        </div>
      </details>
      <details className="rounded-md border border-slate-300 p-3 text-sm dark:border-slate-700">
        <summary className="cursor-pointer font-medium">Download a .iaconfig instead</summary>
        <p className="mt-2 text-xs">
          Self-hosted servers and managed rollouts can ship the client with a signed IndiansAssist.iaconfig file next to it. Your technician creates it from the
          tokens page (Download .iaconfig for this token).
        </p>
      </details>
    </div>
  );
}
