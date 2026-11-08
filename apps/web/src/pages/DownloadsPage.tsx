/**
 * `/downloads`: the public, sign-in-free downloads page. Grouped by product tier, then platform; each file comes from
 * `GET /api/v1/downloads` (what this server really has), and a slot with no build says "Not available yet" instead of
 * offering a dead link. Every instruction states what the generic file does when it is run: a portable agent served
 * here carries no per-download code, an installer needs a signed enrollment config, and the extension is loaded
 * unpacked until it is in the stores.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  publicDownloadsSchema,
  type PublicDownloadArch,
  type PublicDownloadFile,
  type PublicDownloadFormat,
  type PublicDownloadPlatform,
  type PublicDownloadTier,
  type PublicDownloads,
} from '@indiansassist/shared';
import { CopyButton } from '../components/CopyButton';
import { Alert, Badge, Button, Spinner } from '../components/ui';
import { APP_NAME } from '../config';
import { api, errorMessage } from '../lib/api';
import { PublicLayout, TextLink } from './PublicLayout';

export const NOT_AVAILABLE_TEXT = 'Not available yet';

type Slot = { arch: PublicDownloadArch; format: PublicDownloadFormat; label: string };
type PlatformGroup = { platform: PublicDownloadPlatform; title: string; slots: Slot[]; instructions: ReactNode };
type TierGroup = { tier: PublicDownloadTier; title: string; summary: string; platforms: PlatformGroup[] };

export const downloadsApi = {
  list: () => api.get<PublicDownloads>('/downloads', { schema: publicDownloadsSchema }),
};

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const JOIN_LINK_LINE = (
  <p>
    <strong>Fastest:</strong> open the join link your technician sent you and download from there. That copy already knows your session, so it connects on its
    own.
  </p>
);

function Code({ children }: { children: string }) {
  return <code className="break-all rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">{children}</code>;
}

function Commands({ lines }: { lines: string }) {
  return (
    <div className="mt-1 flex flex-col gap-1">
      <pre className="whitespace-pre-wrap break-all rounded bg-slate-100 p-2 font-mono text-xs dark:bg-slate-800">{lines}</pre>
      <div>
        <CopyButton text={lines} label="Copy" againLabel="Copy again" variant="secondary" size="sm" />
      </div>
    </div>
  );
}

const CATALOG: TierGroup[] = [
  {
    tier: 'p2_extension',
    title: 'Browser extension',
    summary: 'Shares only the Chrome or Edge tabs you choose, with sensitive fields masked. Nothing else on the computer is shared.',
    platforms: [
      {
        platform: 'browser',
        title: 'Chrome and Edge',
        slots: [{ arch: 'universal', format: 'zip', label: 'Extension package (.zip)' }],
        instructions: (
          <>
            <p>The extension is not in the Chrome Web Store or Edge Add-ons yet, so it is added by hand:</p>
            <ol className="list-decimal pl-5">
              <li>Download the .zip and unzip it into a folder you will keep; deleting the folder removes the extension.</li>
              <li>
                <strong>Chrome:</strong> open <Code>chrome://extensions</Code>. <strong>Edge:</strong> open <Code>edge://extensions</Code>.
              </li>
              <li>Turn on Developer mode.</li>
              <li>Choose Load unpacked and select the folder that holds manifest.json.</li>
              <li>Open the join link your technician sent you; the page finds the extension without a reload.</li>
            </ol>
          </>
        ),
      },
    ],
  },
  {
    tier: 'p3_portable',
    title: 'Support client (portable, no install)',
    summary: 'Lets a technician view and, if you allow it, control this device for one session. It shows a consent window first and removes itself when you close it.',
    platforms: [
      {
        platform: 'windows',
        title: 'Windows',
        slots: [
          { arch: 'x64', format: 'exe', label: '64-bit Intel or AMD (.exe)' },
          { arch: 'arm64', format: 'exe', label: 'ARM64 (.exe)' },
        ],
        instructions: (
          <>
            {JOIN_LINK_LINE}
            <p>
              <strong>This generic file has no session code.</strong> Double-clicked, it shows a message and closes. If you have the 12-digit support code, start it from
              PowerShell in the download folder:
            </p>
            <Commands lines={'.\\IndiansAssist-windows-x64-<version>.exe --code <12-digit code>'} />
            <p>Or rename the file to <Code>IndiansAssist-in-mum-1234-5678-9012.exe</Code> using your own code, then open it.</p>
            <p>Windows may say the publisher is unknown: the current certificate is self-signed. Check the file against the sha256 above before you run it.</p>
          </>
        ),
      },
      {
        platform: 'linux',
        title: 'Linux',
        slots: [{ arch: 'x64', format: 'tar.gz', label: 'x86-64 (.tar.gz)' }],
        instructions: (
          <>
            {JOIN_LINK_LINE}
            <p>
              <strong>This generic file has no session code.</strong> The archive unpacks the agent and <Code>.ia-portal</Code>, which shares the screen on Wayland. Run it in a
              terminal with your 12-digit support code:
            </p>
            <Commands lines={'tar -xzf IndiansAssist-linux-x64-<version>.tar.gz\n./IndiansAssist-linux-x64-<version> --code <12-digit code>'} />
            <p>On an X11 desktop you can instead copy the code first; the program reads it from the clipboard. It needs a glibc 2.34 or later x86-64 Linux. On Wayland the technician can see the screen but not control it. It is not code-signed; compare the sha256 above.</p>
          </>
        ),
      },
      {
        platform: 'macos',
        title: 'macOS',
        slots: [
          { arch: 'arm64', format: 'app.zip', label: 'Apple silicon (.app.zip)' },
          { arch: 'x64', format: 'app.zip', label: 'Intel (.app.zip)' },
        ],
        instructions: (
          <>
            {JOIN_LINK_LINE}
            <p>
              <strong>This generic file has no session code.</strong> Unzip it and start it from Terminal with your 12-digit support code:
            </p>
            <Commands lines={'open -a ./IndiansAssist.app --args --code <12-digit code>'} />
            <p>macOS builds are signed ad hoc only, so macOS asks you to allow them in System Settings, Privacy &amp; Security.</p>
          </>
        ),
      },
      {
        platform: 'android',
        title: 'Android',
        slots: [{ arch: 'universal', format: 'apk', label: 'Universal (.apk)' }],
        instructions: (
          <p>
            Install the .apk (Android asks you to allow installs from this source), open IndiansAssist, then open your join link, scan your technician&apos;s QR code, or
            paste your support code in the app.
          </p>
        ),
      },
    ],
  },
  {
    tier: 'p4_installed',
    title: 'Installed agent (managed devices)',
    summary: 'For IT teams: runs as a service for unattended access under your organisation\'s policy. Every installer needs a signed enrollment file from your own account.',
    platforms: [
      {
        platform: 'windows',
        title: 'Windows',
        slots: [
          { arch: 'x64', format: 'msi', label: '64-bit installer (.msi)' },
          { arch: 'arm64', format: 'msi', label: 'ARM64 installer (.msi)' },
        ],
        instructions: (
          <>
            <p>
              Nothing happens until the device is enrolled. An organisation admin gets the signed <Code>enroll.iaconfig</Code> from the{' '}
              <TextLink to="/app/tokens">Tokens page</TextLink> (create an enrollment token, then Install and enroll). Install with it:
            </p>
            <Commands lines={'msiexec /i IndiansAssist-Agent-<version>-windows-x64.msi IA_ENROLL=<value from the Tokens page> /qn /norestart'} />
            <p>Treat the config and the IA_ENROLL value as secrets. Group Policy and Intune steps are on the Tokens page.</p>
          </>
        ),
      },
      {
        platform: 'linux',
        title: 'Linux',
        slots: [
          { arch: 'x64', format: 'deb', label: 'Debian and Ubuntu (.deb)' },
          { arch: 'x64', format: 'rpm', label: 'RHEL and Fedora (.rpm)' },
        ],
        instructions: (
          <>
            <p>
              Download <Code>enroll.iaconfig</Code> from the <TextLink to="/app/tokens">Tokens page</TextLink> (an enrollment token, Install and enroll), then:
            </p>
            <Commands lines={'sudo install -D -m 0600 enroll.iaconfig /etc/indiansassist/enroll.iaconfig\nsudo apt install ./IndiansAssist-Agent-<version>-linux-x64.deb\n# or: sudo dnf install ./IndiansAssist-Agent-<version>-linux-x64.rpm'} />
            <p>Needs x86-64 with glibc 2.34 or later (Ubuntu 22.04, Debian 12, EL 9, Fedora).</p>
          </>
        ),
      },
      {
        platform: 'macos',
        title: 'macOS',
        slots: [
          { arch: 'arm64', format: 'pkg', label: 'Apple silicon (.pkg)' },
          { arch: 'x64', format: 'pkg', label: 'Intel (.pkg)' },
        ],
        instructions: (
          <p>
            Download <Code>enroll.iaconfig</Code> from the <TextLink to="/app/tokens">Tokens page</TextLink> (Install and enroll) and place it at{' '}
            <Code>/Library/Application Support/IndiansAssist/enroll.iaconfig</Code> before installing the package.
          </p>
        ),
      },
    ],
  },
];

function findFile(files: PublicDownloadFile[], tier: PublicDownloadTier, platform: PublicDownloadPlatform, slot: Slot): PublicDownloadFile | undefined {
  return files.find((f) => f.tier === tier && f.platform === platform && f.arch === slot.arch && f.format === slot.format);
}

function DownloadRow({ tier, platform, slot, file }: { tier: PublicDownloadTier; platform: PublicDownloadPlatform; slot: Slot; file: PublicDownloadFile | undefined }) {
  const name = `${slot.label} for ${platform}`;
  return (
    <li className="flex flex-col gap-1 rounded-md border border-slate-300 p-3 text-sm dark:border-slate-700" data-testid={`dl-${tier}-${platform}-${slot.arch}-${slot.format}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{slot.label}</span>
        {file ? (
          <a
            href={file.url}
            download={file.filename}
            rel="noopener"
            aria-label={`Download ${name}`}
            className="inline-flex min-h-10 items-center justify-center rounded-md bg-teal-700 px-4 text-sm font-medium text-white hover:bg-teal-800"
          >
            Download
          </a>
        ) : (
          <Badge tone="neutral">{NOT_AVAILABLE_TEXT}</Badge>
        )}
      </div>
      {file && (
        <>
          <p className="text-xs">
            Version {file.version}, {formatSize(file.size)}
            {file.minOs ? `, ${file.minOs}` : ''}. {file.signed ? 'Signed.' : 'Not signed.'}
          </p>
          <p className="text-xs" data-testid="dl-sha256">
            sha256 <span className="break-all font-mono">{file.sha256}</span>
          </p>
        </>
      )}
    </li>
  );
}

export function DownloadsPage({ load = downloadsApi.list }: { load?: () => Promise<PublicDownloads> }) {
  const [state, setState] = useState<{ k: 'loading' } | { k: 'error'; message: string } | { k: 'ok'; files: PublicDownloadFile[] }>({ k: 'loading' });

  const fetchList = useCallback(() => {
    setState({ k: 'loading' });
    load().then(
      (r) => setState({ k: 'ok', files: r.files }),
      (e: unknown) => setState({ k: 'error', message: errorMessage(e) }),
    );
  }, [load]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const files = state.k === 'ok' ? state.files : [];

  return (
    <PublicLayout title={`Download ${APP_NAME}`} wide>
      <div className="flex flex-col gap-4 text-sm" data-testid="downloads-page">
        <p>
          Downloads for the computer or phone being helped, and for IT teams rolling out managed devices. If a technician is helping you, the easiest route is
          always the link they sent you; you usually do not need this page.
        </p>
        <section aria-labelledby="tier-browser" className="flex flex-col gap-1">
          <h2 id="tier-browser" className="text-base font-semibold">
            Web browser (nothing to install)
          </h2>
          <p>The basic session runs inside any modern browser. There is no file to download: open the join link your technician sends you.</p>
        </section>
        {state.k === 'loading' && <Spinner label="Checking what is available" />}
        {state.k === 'error' && (
          <div className="flex flex-col gap-2">
            <Alert>{state.message}</Alert>
            <div>
              <Button variant="secondary" onClick={fetchList}>
                Try again
              </Button>
            </div>
          </div>
        )}
        {state.k !== 'error' &&
          CATALOG.map((tier) => (
            <section key={tier.tier} aria-labelledby={`tier-${tier.tier}`} className="flex flex-col gap-3">
              <div>
                <h2 id={`tier-${tier.tier}`} className="text-base font-semibold">
                  {tier.title}
                </h2>
                <p>{tier.summary}</p>
              </div>
              {tier.platforms.map((group) => (
                <div key={group.platform} className="flex flex-col gap-2">
                  <h3 className="font-medium">{group.title}</h3>
                  <ul className="flex flex-col gap-2">
                    {group.slots.map((slot) => (
                      <DownloadRow key={`${slot.arch}-${slot.format}`} tier={tier.tier} platform={group.platform} slot={slot} file={findFile(files, tier.tier, group.platform, slot)} />
                    ))}
                  </ul>
                  <details className="rounded-md border border-slate-300 p-3 dark:border-slate-700">
                    <summary className="cursor-pointer font-medium">How to use it</summary>
                    <div className="mt-2 flex flex-col gap-2">{group.instructions}</div>
                  </details>
                </div>
              ))}
            </section>
          ))}
        <section aria-labelledby="tier-ios" className="flex flex-col gap-1">
          <h2 id="tier-ios" className="text-base font-semibold">
            iPhone and iPad
          </h2>
          <p>Not available yet: the iOS app has to come through the App Store. Use a browser session instead.</p>
        </section>
        <p className="text-xs text-slate-600 dark:text-slate-400">
          Sign in to the console at <Link to="/login" className="underline">the sign-in page</Link>. Verify a file by comparing its sha256 with the value listed here.
        </p>
      </div>
    </PublicLayout>
  );
}
