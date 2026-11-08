/**
 * /join for a `p3_portable` token (docs/specs/phase-c-contracts.md section 2.7 J1-J6). Windows: **Download
 * IndiansAssist** through the grant flow (`POST /download/prepare`, then a programmatic `<a download>`); the page
 * writes nothing to the clipboard on its own; **Copy support code** copies the per-download desk code only; ARM64
 * link; sha256 / version and the signed line; **Download again** after a `410`; deep link only after Keep (L3) or on
 * **I already have IndiansAssist**. Android: the App Link, then **Get the app**, **Copy token** and a QR. iOS: text.
 * Linux (Phase E section 7.6): **Download for Linux (x86-64, X11)** of the per-download `.tar.gz`, the X11 line, a
 * copy button for the exact `cd ~/Downloads && tar -xzf ... && ./...` line, and the ELF's sha256 from the build. Phase F
 * section 9.5: one download, **Download for Linux (x86-64)**, that works on X11 and Wayland (the portal companion
 * `.ia-portal` rides in the same archive), with the companion's sha256 on a second line when the build has one.
 * Nothing is stored for the room and the page never navigates to /room for this tier.
 */
import { useEffect, useRef, useState } from 'react';
import type { AgentArch, AgentPlatform, DownloadManifest, DownloadPrepareReply, PublicToken } from '@indiansassist/shared';
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
  linuxRunCommand,
  tryDeepLink,
  type DeepLinkEnv,
} from './agentDownload';

export const P3_INTRO = 'This session uses the IndiansAssist support client. It runs without installing anything and removes itself when you close it.';
export const P3_UNAVAILABLE = 'The support client is not available on this server; ask your technician for a browser screen-share link instead.';
export const P3_IOS = 'Android only for now; ask your technician for a browser screen-share link.';
export const P3_LINUX_DOWNLOAD = 'Download for Linux (x86-64)';
/** Phase F section 9.5: the line under the single Linux button when the build carries the Wayland portal companion. */
export const P3_LINUX_BOTH = 'Works on X11 and Wayland desktops. On Wayland the technician can see your screen but cannot control it.';
/** A Linux build without the companion (a server that ships only the X11 binary): the Phase E line. */
export const P3_LINUX_X11 = 'Needs an X11 (Xorg) session to share the screen.';

export type JoinP3Env = {
  nav: { userAgent: string; userAgentData?: { platform?: string } };
  origin: string;
  deepLink: DeepLinkEnv;
  storage: Pick<Storage, 'getItem'>;
  download: (url: string, filename: string) => void;
  /** HEAD of a grant URL (uncounted): the status, 0 on a network error. */
  probe: (url: string) => Promise<number>;
  prepare: (code: string, platform: AgentPlatform, arch: AgentArch) => Promise<DownloadPrepareReply>;
  /** `GET /download/manifest` (public): whether this server has a Linux build (`PublicToken.agent` has no Linux flag). */
  manifest: () => Promise<DownloadManifest>;
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
    manifest: downloadApi.manifest,
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
  /** Linux only: true / false once the manifest answered, null before (or when it could not be read: prepare decides). */
  const [linuxAvailable, setLinuxAvailable] = useState<boolean | null>(null);
  /** Phase F section 9.5: the portal companion of the Linux build (sha256, size), when the manifest names one. */
  const [companion, setCompanion] = useState<{ sha256: string; size: number } | null>(null);
  const joinLink = joinLinkFor(env.origin, code);

  const openApp = async () => {
    const opened = await tryDeepLink(deepLinkFor(code), env.deepLink);
    if (!opened) setShowDownload(true);
  };

  useEffect(() => {
    // L3: the deep link is tried automatically only after the Desk chose Keep on this browser.
    if (tried.current || !seen || (platform !== 'windows' && platform !== 'linux')) return;
    tried.current = true;
    void openApp();
  }, []);

  useEffect(() => {
    if (platform !== 'linux') return;
    let live = true;
    env.manifest().then(
      (m) => {
        if (!live) return;
        const linux = m.builds.find((b) => b.platform === 'linux' && b.arch === 'x64');
        setLinuxAvailable(Boolean(linux));
        setCompanion(linux?.companion ?? null);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
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
              <>
                <Alert tone="amber">{P3_UNAVAILABLE}</Alert>
                <p className="text-sm">
                  You can check the{' '}
                  <a href="/downloads" className="font-medium text-teal-800 underline dark:text-teal-300">
                    downloads page
                  </a>{' '}
                  for the Android app.
                </p>
              </>
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

  if (platform === 'linux') {
    const command = prep ? linuxRunCommand(prep.filename) : null;
    const inner = prep ? prep.filename.replace(/\.tar\.gz$/, '') : '';
    const sessionLine = companion ? P3_LINUX_BOTH : P3_LINUX_X11;
    return (
      <div className="flex flex-col gap-3" data-testid="join-p3-linux">
        <p className="text-sm">{P3_INTRO}</p>
        {linuxAvailable === false && <Alert tone="amber">{P3_UNAVAILABLE}</Alert>}
        {seen && (
          <Button size="lg" onClick={() => void openApp()} disabled={expired} style={!expired ? { backgroundColor: accent } : undefined}>
            Open IndiansAssist
          </Button>
        )}
        {linuxAvailable !== false && showDownload && !prep && (
          <div className="flex flex-col gap-2">
            <Button size="lg" onClick={() => start('x64', 'linux')} disabled={busy || expired} style={!expired ? { backgroundColor: accent } : undefined}>
              {busy ? 'Preparing your download...' : P3_LINUX_DOWNLOAD}
            </Button>
            <p className="text-xs text-slate-600 dark:text-slate-400" data-testid="p3-linux-line">
              {sessionLine}
            </p>
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
              The download is <strong className="break-all">{prep.filename}</strong>. Open a terminal and run this line: it unpacks the client and starts it, and
              it connects on its own.
            </p>
            {command && (
              <>
                <pre className="whitespace-pre-wrap break-all rounded bg-slate-100 p-2 font-mono text-xs dark:bg-slate-800" data-testid="p3-linux-command">
                  {command}
                </pre>
                <div>
                  <CopyButton text={command} label="Copy command" againLabel="Copy command again" variant="secondary" size="sm" />
                </div>
              </>
            )}
            <p className="text-xs">{sessionLine}</p>
            <div className="flex flex-wrap items-center gap-2">
              <CopyButton text={prep.deskCode} label="Copy support code" againLabel="Copy support code again" variant="secondary" size="sm" />
              <span className="font-mono text-xs">{groupCode(prep.deskCode)}</span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400">Use the support code only if the client asks for it.</p>
            <p className="text-xs" data-testid="p3-sha">
              Version {prep.version}, sha256 of the program <span className="break-all font-mono">{inner}</span>:{' '}
              <span className="break-all font-mono">{prep.sha256}</span>
            </p>
            {companion && (
              <p className="text-xs" data-testid="p3-sha-portal">
                sha256 of <span className="font-mono">.ia-portal</span>, the part that shares a Wayland screen:{' '}
                <span className="break-all font-mono">{companion.sha256}</span>
              </p>
            )}
            <Alert tone="amber">
              The Linux client is not code-signed. To verify it, run{' '}
              <span className="break-all font-mono">{companion ? `sha256sum ${inner} .ia-portal` : `sha256sum ${inner}`}</span> after unpacking: it must print
              {companion ? ' the values above.' : ' the value above.'}
            </Alert>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" disabled={busy || expired} onClick={() => void again()}>
                Download again
              </Button>
            </div>
          </section>
        )}
        <details className="rounded-md border border-slate-300 p-3 text-sm dark:border-slate-700">
          <summary className="cursor-pointer font-medium">Join from another device</summary>
          <div className="mt-2">
            <QrCode text={joinLink} label="QR code of this join link for another device" size={176} />
          </div>
        </details>
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
