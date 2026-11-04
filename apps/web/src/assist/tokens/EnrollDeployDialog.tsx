/**
 * "Install and enroll" for one enrollment token (Phase D section 13.4 tokens-page row, 12.1 channels): the group
 * selector, the signed `enroll.iaconfig` download from `GET /devices/enroll-config` (org_admin), the branded
 * installer itself when this server has one (`GET /download/installer`, offered per architecture and audited against
 * this token), and the GPO / Intune copy-paste snippets of that same signed config. The value is a secret, so it is
 * copied, not shown, until the technician asks to see it.
 *
 * Phase F section 8.11: one tab per platform. **Linux** offers the deb and the rpm with their sha256 (the packages
 * are unsigned, W111), the config download, the `sudo` commands and a copyable Ansible snippet that uses the role's
 * prefixed variables (section 8.10). **macOS** appears only when this server lists a macOS PKG: the PKG with its
 * sha256 (and a "not signed" note until a Developer ID Installer identity exists), the config download and the
 * `installer` command (section 17.3). The tabs follow the WAI-ARIA tabs pattern, so they work from the keyboard.
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import {
  installerFileName,
  installerFormatOf,
  installerPlatformOf,
  type InstallerBuild,
  type InstallerPlatform,
  type Token,
} from '@indiansassist/shared';
import { CopyButton } from '../../components/CopyButton';
import { Dialog } from '../../components/Dialog';
import { Alert, Button, Field, Select, Spinner } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { saveText } from '../../lib/agentApi';
import { errorMessage } from '../../lib/api';
import { deviceGroupsApi, installerApi } from '../../lib/fleetApi';
import { ENROLL_SECRET_TEXT, enrollConfigApi, enrollmentUsage, gpoSnippet, iaEnrollValue, intuneSnippet, MSI_FILE_NAME } from './enroll';

/** Section 8.3c: where the Linux service looks for the config (mode 0600 root). */
export const LINUX_ENROLL_PATH = '/etc/indiansassist/enroll.iaconfig';
/** Section 17.3: where the macOS PKG's postinstall looks for the config (mode 0600). */
export const MACOS_ENROLL_PATH = '/Library/Application Support/IndiansAssist/enroll.iaconfig';
/** The Linux package names when this server serves none (section 8.9). */
export const LINUX_FILE_NAMES = { deb: 'IndiansAssist-Agent-<version>-linux-x64.deb', rpm: 'IndiansAssist-Agent-<version>-linux-x64.rpm' } as const;

const linkClass =
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-slate-400 bg-white px-4 text-sm font-medium text-slate-900 transition-colors hover:bg-slate-100 dark:border-slate-500 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800';
const preClass = 'mt-1 overflow-x-auto whitespace-pre rounded bg-slate-100 p-2 text-xs dark:bg-slate-800';

/** A served build's file name, as the route sends it. */
export function buildFileName(b: InstallerBuild): string {
  return installerFileName(b.arch, b.version, installerFormatOf(b));
}

/**
 * Section 8.11: place the config first (the service enrolls at its first start, which the package's postinst
 * triggers), then install. `install -D` creates `/etc/indiansassist` when the package is not there yet; systemd sets
 * its 0750 mode (`ConfigurationDirectoryMode=`) when the unit starts.
 */
export function linuxSudoCommand(format: 'deb' | 'rpm', file: string): string {
  const place = `sudo install -D -m 0600 enroll.iaconfig ${LINUX_ENROLL_PATH}`;
  return `${place} && sudo ${format === 'deb' ? 'apt' : 'dnf'} install ./${file}`;
}

/**
 * Section 8.10: a playbook using the role, with the role-prefixed variables. The package URL is the administrator's
 * own share (the api's download needs a signed-in org_admin), and the config is read from a file beside the
 * playbook, so the secret is never pasted into it (keep it in Ansible Vault for a shared repository).
 */
export function ansibleSnippet(file: string, sha256: string): string {
  return [
    '- name: Install the IndiansAssist agent',
    '  hosts: linux_desks',
    '  become: true',
    '  roles:',
    '    - role: indiansassist_agent',
    '      vars:',
    '        indiansassist_agent_state: present',
    `        indiansassist_agent_package_url: "https://<your-file-share>/${file}"`,
    `        indiansassist_agent_package_sha256: "${sha256}"`,
    `        indiansassist_agent_enroll_config: "{{ lookup('ansible.builtin.file', 'enroll.iaconfig') }}"`,
  ].join('\n');
}

/** Section 17.3: the config at its path (0600), then the PKG. */
export function macosCommands(file: string): string {
  return [
    'sudo install -d -m 0755 "/Library/Application Support/IndiansAssist"',
    `sudo install -m 0600 enroll.iaconfig "${MACOS_ENROLL_PATH}"`,
    `sudo installer -pkg ${file} -target /`,
  ].join('\n');
}

const TAB_LABELS: Record<InstallerPlatform, string> = { windows: 'Windows', linux: 'Linux', macos: 'macOS' };

/** WAI-ARIA tabs: arrow keys, Home and End move the selection, and only the selected tab is in the tab order. */
function PlatformTabs({ tabs, active, onChange }: { tabs: InstallerPlatform[]; active: InstallerPlatform; onChange: (t: InstallerPlatform) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = tabs.indexOf(active);
    const to =
      e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1] : undefined;
    if (!to) return;
    e.preventDefault();
    onChange(to);
    refs.current[to]?.focus();
  };
  return (
    <div role="tablist" aria-label="Platform" className="flex gap-1 border-b border-slate-300 dark:border-slate-700">
      {tabs.map((t) => (
        <button
          key={t}
          ref={(el) => {
            refs.current[t] = el;
          }}
          type="button"
          role="tab"
          id={`enroll-tab-${t}`}
          aria-selected={active === t}
          aria-controls={`enroll-panel-${t}`}
          tabIndex={active === t ? 0 : -1}
          onClick={() => onChange(t)}
          onKeyDown={onKeyDown}
          className={`min-h-10 rounded-t-md px-4 text-sm font-medium ${active === t ? 'border-b-2 border-teal-700 text-teal-800 dark:text-teal-300' : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
        >
          {TAB_LABELS[t]}
        </button>
      ))}
    </div>
  );
}

/** One package: its download link (audited against the token) and its sha256 to compare. */
function PackageRow({ b, tokenId, label }: { b: InstallerBuild; tokenId: string; label: string }) {
  const format = installerFormatOf(b);
  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <a href={installerApi.url(b.arch, tokenId, format)} className={linkClass}>
          {label}
        </a>
        <CopyButton variant="ghost" size="sm" text={b.sha256} label={`Copy the .${format} sha256`} />
      </div>
      <p className="break-all text-xs">
        sha256 <span className="font-mono">{b.sha256}</span>
      </p>
    </li>
  );
}

function WindowsPanel({ builds, tokenId, config, orgName }: { builds: InstallerBuild[]; tokenId: string; config: string; orgName: string }) {
  const [revealed, setRevealed] = useState(false);
  const iaEnroll = iaEnrollValue(config);
  const gpo = gpoSnippet(iaEnroll, orgName);
  const intune = intuneSnippet(iaEnroll);
  return (
    <div className="flex flex-col gap-3">
      {builds.length === 0 ? (
        <p className="text-sm">
          Step 1: take the signed base installer <span className="font-mono text-xs">{MSI_FILE_NAME}</span> from your release
          share. This server does not serve the MSI itself. Step 2: hand it the config below, as a transform (GPO) or as the{' '}
          <span className="font-mono text-xs">IA_ENROLL</span> property (Intune, msiexec).
        </p>
      ) : (
        <>
          <p className="text-sm">
            Step 1: download the signed base installer for the architecture you are deploying. Step 2: hand it the config
            below, as a transform (GPO) or as the <span className="font-mono text-xs">IA_ENROLL</span> property (Intune,
            msiexec). The installer carries no organisation of its own: the config does.
          </p>
          <div className="flex flex-wrap items-center gap-2" data-testid="installer-downloads">
            {builds.map((b) => (
              <a key={b.arch} href={installerApi.url(b.arch, tokenId)} className={linkClass}>
                {`Download the installer (${b.arch}, ${b.version})`}
              </a>
            ))}
          </div>
          {builds.some((b) => !b.signed) && (
            <Alert tone="amber">
              {`This server serves an unsigned build (${builds
                .filter((b) => !b.signed)
                .map((b) => b.arch)
                .join(', ')}). Do not deploy it: a release installer is Authenticode-signed, and the service checks the signer at runtime.`}
            </Alert>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => saveText(config, 'enroll.iaconfig')}>
          Download enroll.iaconfig
        </Button>
        <CopyButton variant="secondary" text={iaEnroll} label="Copy the IA_ENROLL value" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton variant="secondary" text={gpo} label="Copy the GPO snippet" />
        <CopyButton variant="secondary" text={intune} label="Copy the Intune snippet" />
        <Button variant="ghost" onClick={() => setRevealed((v) => !v)}>
          {revealed ? 'Hide the secret value' : 'Show the secret value'}
        </Button>
      </div>
      {revealed && (
        <div className="flex flex-col gap-3">
          <div>
            <h3 className="text-sm font-semibold">Group Policy (MSI + MST)</h3>
            <pre data-testid="gpo-snippet" className={preClass}>
              {gpo}
            </pre>
          </div>
          <div>
            <h3 className="text-sm font-semibold">Intune</h3>
            <pre data-testid="intune-snippet" className={preClass}>
              {intune}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function LinuxPanel({ builds, tokenId, config }: { builds: InstallerBuild[]; tokenId: string; config: string }) {
  const deb = builds.find((b) => installerFormatOf(b) === 'deb');
  const rpm = builds.find((b) => installerFormatOf(b) === 'rpm');
  const debFile = deb ? buildFileName(deb) : LINUX_FILE_NAMES.deb;
  const rpmFile = rpm ? buildFileName(rpm) : LINUX_FILE_NAMES.rpm;
  const commands = `# Debian, Ubuntu\n${linuxSudoCommand('deb', debFile)}\n# RHEL, Fedora, SUSE\n${linuxSudoCommand('rpm', rpmFile)}`;
  const ansibleDeb = ansibleSnippet(debFile, deb?.sha256 ?? '<sha256 of the package>');
  const ansibleRpm = ansibleSnippet(rpmFile, rpm?.sha256 ?? '<sha256 of the package>');
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        Step 1: download the package for the distribution{builds[0]?.minOs ? ` (${builds[0].minOs})` : ''}. Step 2: place the config below at <span className="font-mono text-xs">{LINUX_ENROLL_PATH}</span>{' '}
        (mode 0600), then install the package; the service enrolls at its first start. The packages are not signed:
        compare the sha256 before installing.
      </p>
      {builds.length === 0 ? (
        <p className="text-sm" data-testid="linux-release-share">
          This server does not serve the Linux packages. Take <span className="font-mono text-xs">{LINUX_FILE_NAMES.deb}</span>{' '}
          or <span className="font-mono text-xs">.rpm</span> and its sha256 from your release share.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="linux-downloads">
          {[deb, rpm]
            .filter((b): b is InstallerBuild => b !== undefined)
            .map((b) => (
              <PackageRow key={installerFormatOf(b)} b={b} tokenId={tokenId} label={`Download the .${installerFormatOf(b)} package (${b.arch}, ${b.version})`} />
            ))}
        </ul>
      )}
      <div>
        <Button variant="secondary" onClick={() => saveText(config, 'enroll.iaconfig')}>
          Download enroll.iaconfig
        </Button>
      </div>
      <div>
        <h3 className="text-sm font-semibold">Install by hand</h3>
        <pre data-testid="linux-commands" className={preClass}>
          {commands}
        </pre>
        <CopyButton variant="secondary" size="sm" text={commands} label="Copy the install commands" />
      </div>
      <div>
        <h3 className="text-sm font-semibold">Ansible</h3>
        <p className="text-xs text-slate-600 dark:text-slate-400">
          Uses the <span className="font-mono">indiansassist_agent</span> role. Put the package on a share your hosts can
          reach and keep <span className="font-mono">enroll.iaconfig</span> beside the playbook (or in Ansible Vault); the
          role writes it only to a device that is not enrolled yet.
        </p>
        <pre data-testid="ansible-snippet" className={preClass}>
          {ansibleDeb}
        </pre>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton variant="secondary" size="sm" text={ansibleDeb} label="Copy the Ansible snippet (.deb)" />
          <CopyButton variant="secondary" size="sm" text={ansibleRpm} label="Copy the Ansible snippet (.rpm)" />
        </div>
      </div>
    </div>
  );
}

function MacosPanel({ builds, tokenId, config }: { builds: InstallerBuild[]; tokenId: string; config: string }) {
  const first = builds[0]!;
  const commands = macosCommands(buildFileName(first));
  const unsigned = builds.filter((b) => b.signed !== true);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        Step 1: download the PKG for the Mac&apos;s architecture. Step 2: place the config below at{' '}
        <span className="font-mono text-xs">{MACOS_ENROLL_PATH}</span> (mode 0600), then install the PKG; the agent enrolls
        when it starts.
      </p>
      <ul className="flex flex-col gap-2" data-testid="macos-downloads">
        {builds.map((b) => (
          <PackageRow key={b.arch} b={b} tokenId={tokenId} label={`Download the PKG (${b.arch}, ${b.version})`} />
        ))}
      </ul>
      {unsigned.length > 0 && (
        <Alert tone="amber">
          {`This PKG is not signed (${unsigned.map((b) => b.arch).join(', ')}): no Developer ID Installer identity signed it yet, so macOS warns before installing. Compare the sha256 before you deploy it.`}
        </Alert>
      )}
      <div>
        <Button variant="secondary" onClick={() => saveText(config, 'enroll.iaconfig')}>
          Download enroll.iaconfig
        </Button>
      </div>
      <div>
        <h3 className="text-sm font-semibold">Install</h3>
        <pre data-testid="macos-commands" className={preClass}>
          {commands}
        </pre>
        <CopyButton variant="secondary" size="sm" text={commands} label="Copy the install commands" />
      </div>
    </div>
  );
}

export function EnrollDeployDialog({
  token,
  orgName,
  open,
  onClose,
}: {
  token: Token | null;
  orgName: string;
  open: boolean;
  onClose: () => void;
}) {
  const [groupId, setGroupId] = useState('');
  const [config, setConfig] = useState<string | null>(null);
  const [tab, setTab] = useState<InstallerPlatform>('windows');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = useAsync(async () => (open ? (await deviceGroupsApi.list()).items : []), [open]);
  // Section 13.4: the installer is offered only when this node actually serves one. A node that serves none answers
  // `builds: []`, and a node too old to know the route answers 404; both mean "not available", never a broken link.
  const installer = useAsync(async () => (open ? await installerApi.manifest().catch(() => null) : null), [open]);

  const close = () => {
    setConfig(null);
    setError(null);
    setTab('windows');
    onClose();
  };

  const issue = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const r = await enrollConfigApi.get(token.id, groupId || undefined);
      setConfig(r.iaconfig);
    } catch (e) {
      setConfig(null);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const usage = token ? enrollmentUsage(token) : null;
  const all = [...(installer.data?.builds ?? [])].sort((a, b) => a.arch.localeCompare(b.arch));
  const of = (p: InstallerPlatform) => all.filter((b) => installerPlatformOf(b) === p);
  const macos = of('macos');
  const tabs: InstallerPlatform[] = macos.length > 0 ? ['windows', 'linux', 'macos'] : ['windows', 'linux'];
  const shown = tabs.includes(tab) ? tab : 'windows';

  return (
    <Dialog open={open && token !== null} title="Install and enroll devices with this token" onClose={close} wide>
      {token && usage && (
        <div className="flex flex-col gap-4">
          <Alert tone="amber">{ENROLL_SECRET_TEXT}</Alert>
          <p data-testid="enroll-usage" className="text-sm">
            This token has enrolled <strong>{usage.enrolled}</strong> of <strong>{usage.max}</strong> devices;{' '}
            {usage.full ? 'it can enroll no more.' : `${usage.remaining} left.`} One config serves the whole rollout
            wave; issue a new token when it runs out.
          </p>
          <Field label="Device group" hint="The group is fixed inside the signed config and cannot be changed later.">
            {(p) => (
              <Select
                id={p.id}
                aria-describedby={p.describedBy}
                value={groupId}
                onChange={(e) => {
                  setGroupId(e.target.value);
                  setConfig(null);
                }}
              >
                <option value="">No group (the organisation default policy applies)</option>
                {(groups.data ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {groups.loading && <Spinner label="Loading device groups" />}
          {Boolean(groups.error) && <Alert tone="amber">Device groups could not be loaded; you can still enroll without a group.</Alert>}
          {error && <Alert>{error}</Alert>}
          <div>
            <Button onClick={() => void issue()} disabled={busy}>
              {config ? 'Issue a fresh config' : 'Get the signed enrollment config'}
            </Button>
          </div>
          {config && (
            <div className="flex flex-col gap-3">
              <PlatformTabs tabs={tabs} active={shown} onChange={setTab} />
              <div role="tabpanel" id={`enroll-panel-${shown}`} aria-labelledby={`enroll-tab-${shown}`} tabIndex={0}>
                {shown === 'windows' && <WindowsPanel key={config} builds={of('windows')} tokenId={token.id} config={config} orgName={orgName} />}
                {shown === 'linux' && <LinuxPanel builds={of('linux')} tokenId={token.id} config={config} />}
                {shown === 'macos' && <MacosPanel builds={macos} tokenId={token.id} config={config} />}
              </div>
            </div>
          )}
          <div className="flex justify-end">
            <Button variant="secondary" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
