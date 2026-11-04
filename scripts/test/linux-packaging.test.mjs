// Phase F contract section 8.12 "Pure" layer for the Linux packaging (stream linux-p4): the unit file and the
// maintainer scripts as text, the package metadata in agent/crates/ia-service/Cargo.toml, the Ansible role YAML
// parsed with structural assertions, the pure helpers of packaging/linux/build.mjs (file names, the installed-file
// manifest, the installer dist manifest checked against the real `installerDistManifestSchema`), and the T2
// throwaway-WSL script's name and refusal rules (its pester-free self-test; the script itself is never run here).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  ARCH,
  MIN_OS,
  distManifest,
  installManifest,
  packageFileName,
  sha256Line,
  toWslPath,
  workspaceVersion,
} from '../../packaging/linux/build.mjs';
import { loadShared } from '../smoke/shared.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LINUX = join(ROOT, 'packaging', 'linux');
const read = (...p) => readFileSync(join(...p), 'utf8');
const HEX = 'ab'.repeat(32);

describe('the systemd unit (section 8.8)', () => {
  const unit = read(LINUX, 'indiansassist-agent.service');
  it('is the contract text, line for line', () => {
    expect(unit.trim().split('\n')).toEqual([
      '[Unit]',
      'Description=IndiansAssist Agent',
      'Documentation=https://<deployment>/docs',
      'After=network-online.target systemd-logind.service',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=notify',
      'ExecStart=/usr/lib/indiansassist/ia-service',
      'Restart=on-failure',
      'RestartSec=5',
      'WatchdogSec=60',
      'TimeoutStopSec=20',
      'KillMode=mixed',
      'UMask=0077',
      'StateDirectory=indiansassist',
      'StateDirectoryMode=0700',
      'ConfigurationDirectory=indiansassist',
      'ConfigurationDirectoryMode=0750',
      'RuntimeDirectory=indiansassist',
      'LockPersonality=yes',
      'RestrictRealtime=yes',
      'SystemCallArchitectures=native',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
    ]);
  });
  it('uses none of the hardening W112 rules out', () => {
    for (const k of ['PrivateTmp', 'ProtectHome', 'ProtectSystem', 'NoNewPrivileges', 'CapabilityBoundingSet']) {
      expect(unit).not.toMatch(new RegExp(`^${k}=`, 'm'));
    }
  });
});

describe('the maintainer scripts (section 8.9)', () => {
  const deb = Object.fromEntries(['postinst', 'prerm', 'postrm'].map((s) => [s, read(LINUX, 'debian', s)]));
  const rpm = Object.fromEntries(['post', 'preun', 'postun'].map((s) => [s, read(LINUX, 'rpm', `${s}.sh`)]));
  const all = { ...deb, ...Object.fromEntries(Object.entries(rpm).map(([k, v]) => [`%${k}`, v])) };

  it('are POSIX sh with LF endings', () => {
    for (const [name, text] of Object.entries(all)) {
      expect(text.startsWith('#!/bin/sh\n'), name).toBe(true);
      expect(text.includes('\r'), name).toBe(false);
    }
  });

  it('run every systemctl only when /run/systemd/system exists', () => {
    for (const [name, text] of Object.entries(all)) {
      const open = []; // one entry per open `if`: whether it is the systemd guard
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (t.startsWith('#')) continue;
        if (/^if\b/.test(t)) open.push(/^if \[ -d \/run\/systemd\/system \]; then$/.test(t));
        else if (/^fi$/.test(t)) open.pop();
        if (/\bsystemctl\b/.test(t)) expect(open.includes(true), `${name}: ${t}`).toBe(true);
      }
      expect(open, name).toEqual([]);
    }
  });

  it('enable --now the unit after install, under systemd only', () => {
    for (const text of [deb.postinst, rpm.post]) {
      expect(text).toMatch(/systemctl daemon-reload/);
      expect(text).toMatch(/systemctl enable --now indiansassist-agent/);
    }
    expect(deb.postinst).toMatch(/configure\)/);
  });

  it('deregister on removal only, bounded to 10 s, with the status ignored, then disable --now', () => {
    for (const text of [deb.prerm, rpm.preun]) {
      expect(text).toContain('timeout -k 2 10 /usr/lib/indiansassist/ia-service --deregister || true');
      expect(text).toContain('/usr/lib/indiansassist/ia-service --deregister || true');
      expect(text.indexOf('--deregister')).toBeLessThan(text.indexOf('systemctl disable --now indiansassist-agent'));
    }
    // dpkg runs prerm with `upgrade` on an upgrade and rpm %preun with $1 = 1: no deregister then.
    expect(deb.prerm).toMatch(/case "\$1" in\s+remove\)/);
    expect(rpm.preun).toMatch(/if \[ "\$1" -eq 0 \]; then/);
  });

  it('remove the state and the config on purge / erase only', () => {
    expect(deb.postrm).toMatch(/purge\)\s+rm -rf \/var\/lib\/indiansassist \/etc\/indiansassist/);
    expect(rpm.postun).toMatch(/if \[ "\$1" -eq 0 \]; then\s+rm -rf \/var\/lib\/indiansassist \/etc\/indiansassist/);
    for (const [name, text] of Object.entries(all)) {
      if (name === 'postrm' || name === '%postun') continue;
      expect(text, name).not.toMatch(/rm -rf/);
    }
  });

  it('download nothing and never touch a home directory', () => {
    for (const [name, text] of Object.entries(all)) {
      expect(text, name).not.toMatch(/\b(curl|wget|fetch)\b|https?:\/\/|\$HOME|~\/|\/home\/|\/root\b/);
    }
  });

  it('always exit 0 at the end (a removal never fails on them)', () => {
    for (const [name, text] of Object.entries(all)) expect(text.trimEnd().endsWith('exit 0'), name).toBe(true);
  });
});

describe('the package metadata (agent/crates/ia-service/Cargo.toml, section 8.9)', () => {
  const toml = read(ROOT, 'agent', 'crates', 'ia-service', 'Cargo.toml');
  const section = (name) => {
    const start = toml.indexOf(`[${name}]`);
    expect(start, name).toBeGreaterThan(-1);
    const rest = toml.slice(start + name.length + 2);
    const next = rest.search(/^\[(?!\s*")/m);
    return next === -1 ? rest : rest.slice(0, next);
  };
  const deb = section('package.metadata.deb');
  const rpm = section('package.metadata.generate-rpm');

  it('names the package as the unit and the Ansible role do', () => {
    expect(deb).toMatch(/^name = "indiansassist-agent"$/m);
    expect(rpm).toMatch(/^name = "indiansassist-agent"$/m);
    const role = read(LINUX, 'ansible', 'roles', 'indiansassist_agent', 'tasks', 'main.yml');
    expect(role).toMatch(/name: indiansassist-agent\n\s+state: absent/);
  });

  it('depends on libc6 (>= 2.34) / glibc >= 2.34 and recommends systemd, nothing else', () => {
    expect(deb).toMatch(/^depends = "libc6 \(>= 2\.34\)"$/m);
    expect(deb).toMatch(/^recommends = "systemd"$/m);
    expect(deb).not.toMatch(/^(pre-depends|suggests|conflicts) =/m);
    expect(section('package.metadata.generate-rpm.requires').trim()).toBe('glibc = ">= 2.34"');
    expect(section('package.metadata.generate-rpm.recommends').trim()).toBe('systemd = "*"');
    expect(rpm).toMatch(/^auto-req = "no"$/m);
  });

  it('ships exactly the five files with the section 8.9 modes', () => {
    const want = [
      ['out/stage/ia-service', 'usr/lib/indiansassist/ia-service', '755'],
      ['out/stage/ia-desktop', 'usr/lib/indiansassist/ia-desktop', '755'],
      ['out/stage/manifest.json', 'usr/lib/indiansassist/manifest.json', '644'],
      ['indiansassist-agent.service', 'usr/lib/systemd/system/indiansassist-agent.service', '644'],
      ['copyright', 'usr/share/doc/indiansassist-agent/copyright', '644'],
    ];
    const debAssets = [...deb.matchAll(/\["\.\.\/\.\.\/\.\.\/packaging\/linux\/([^"]+)", "([^"]+)", "(\d+)"\]/g)].map(
      (m) => m.slice(1),
    );
    expect(debAssets).toEqual(want);
    const rpmAssets = [
      ...rpm.matchAll(
        /source = "\.\.\/\.\.\/\.\.\/packaging\/linux\/([^"]+)", dest = "\/([^"]+)", mode = "(\d+)", user = "root", group = "root"/g,
      ),
    ].map((m) => m.slice(1));
    expect(rpmAssets).toEqual(want);
  });

  it('points the maintainer scripts at packaging/linux', () => {
    expect(deb).toMatch(/^maintainer-scripts = "\.\.\/\.\.\/\.\.\/packaging\/linux\/debian\/"$/m);
    expect(rpm).toMatch(/^post_install_script = "\.\.\/\.\.\/\.\.\/packaging\/linux\/rpm\/post\.sh"$/m);
    expect(rpm).toMatch(/^pre_uninstall_script = "\.\.\/\.\.\/\.\.\/packaging\/linux\/rpm\/preun\.sh"$/m);
    expect(rpm).toMatch(/^post_uninstall_script = "\.\.\/\.\.\/\.\.\/packaging\/linux\/rpm\/postun\.sh"$/m);
  });

  it('carries no real address: only an @example.test maintainer', () => {
    for (const m of toml.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+/g))
      expect(m[0]).toMatch(/@example\.test$/);
  });

  it('is packaged with --no-build (and the deb with --no-strip, so the bytes are the hashed bytes)', () => {
    const sh = read(LINUX, 'build-wsl.sh');
    expect(sh).toMatch(/cargo deb -p ia-service --no-build --no-strip/);
    expect(sh).toMatch(/cargo generate-rpm --auto-req no/);
    expect(sh).toMatch(
      /cargo zigbuild --release --locked --target "\$triple\.2\.34" -p ia-service --features linux-service/,
    );
    expect(sh).toMatch(
      /cargo zigbuild --release --locked --target "\$triple\.2\.34" -p ia-desktop --no-default-features --features linux/,
    );
  });
});

describe('the Ansible role (section 8.10), parsed', () => {
  const role = join(LINUX, 'ansible', 'roles', 'indiansassist_agent');
  const defaults = parseYaml(read(role, 'defaults', 'main.yml'));
  const meta = parseYaml(read(role, 'meta', 'main.yml'));
  const tasks = parseYaml(read(role, 'tasks', 'main.yml'));
  const handlers = parseYaml(read(role, 'handlers', 'main.yml'));
  const flat = (list) => list.flatMap((t) => [t, ...(t.block ? flat(t.block) : [])]);
  const all = flat(tasks);

  it('defaults carry only role-prefixed variables, with the section 8.10 values', () => {
    expect(defaults).toEqual({
      indiansassist_agent_state: 'present',
      indiansassist_agent_package_url: '',
      indiansassist_agent_package_src: '',
      indiansassist_agent_package_sha256: '',
      indiansassist_agent_enroll_config: '',
    });
  });

  it('meta names min_ansible_version 2.16 and the platforms', () => {
    expect(String(meta.galaxy_info.min_ansible_version)).toBe('2.16');
    const names = meta.galaxy_info.platforms.map((p) => p.name);
    for (const n of ['Ubuntu', 'Debian', 'EL', 'Fedora']) expect(names).toContain(n);
  });

  it('fetches with a sha256 checksum, installs unsigned rpms with disable_gpg_check, and hides the enroll config', () => {
    const fetch = all.find((t) => t['ansible.builtin.get_url']);
    expect(fetch['ansible.builtin.get_url'].checksum).toMatch(/^sha256:/);
    expect(all.find((t) => t['ansible.builtin.dnf']?.disable_gpg_check === true)).toBeTruthy();
    const touching = all.filter(
      (t) =>
        JSON.stringify(t).includes('indiansassist_agent_enroll_config') && !t.block && !t['ansible.builtin.assert'],
    );
    expect(touching.length).toBeGreaterThan(0);
    for (const t of touching) expect(t.no_log, t.name).toBe(true);
    const place = all.find((t) => t['ansible.builtin.copy']?.dest === '/etc/indiansassist/enroll.iaconfig');
    expect(place['ansible.builtin.copy'].mode).toBe('0600');
    expect(place.when).toContain('not indiansassist_agent_device_key.stat.exists');
  });

  it('every task is named and uses a fully qualified module; the handler restarts the unit', () => {
    for (const t of all) {
      expect(typeof t.name).toBe('string');
      const mods = Object.keys(t).filter((k) => k.includes('.'));
      if (!t.block) expect(mods.every((m) => m.startsWith('ansible.builtin.'))).toBe(true);
    }
    expect(handlers[0]['ansible.builtin.systemd_service']).toMatchObject({
      name: 'indiansassist-agent',
      state: 'restarted',
    });
  });

  it('absent deregisters with the failure ignored, then removes the package', () => {
    const dereg = all.find(
      (t) => t['ansible.builtin.command']?.cmd === '/usr/lib/indiansassist/ia-service --deregister',
    );
    expect(dereg.failed_when).toBe(false);
    expect(dereg.timeout).toBe(10);
  });
});

describe('T2: agent/scripts/throwaway-wsl.ps1 rules (never run here)', () => {
  const ps1 = read(ROOT, 'agent', 'scripts', 'throwaway-wsl.ps1');

  it('pins the case-sensitive name pattern and the opt-in', () => {
    expect(ps1).toContain("$script:ThrowawayPattern = '^IA-Throwaway-[0-9a-f]{8}$'");
    expect(ps1).toMatch(/-cmatch \$script:ThrowawayPattern/);
    expect(ps1).toMatch(/if \(\$OptIn -ne '1'\)/);
    expect(ps1).toMatch(/Get-ThrowawayRefusal \$Name \(Get-WslDistroNames\) \$env:IA_THROWAWAY_WSL/);
  });

  it('guards every wsl.exe call that names a distro, and always terminates and unregisters in finally', () => {
    const finallyBlock = ps1.slice(ps1.lastIndexOf('} finally {'));
    expect(finallyBlock).toMatch(
      /Assert-ThrowawayTarget \$Name\s+& wsl\.exe --terminate \$Name\s+& wsl\.exe --unregister \$Name/,
    );
    for (const m of ps1.matchAll(/& wsl\.exe ([^\n]*)/g)) {
      expect(m[1], m[0]).not.toMatch(/\bUbuntu\b/);
      if (/-d |--terminate|--unregister/.test(m[1])) expect(m[1]).toMatch(/\$(Name|Distro)/);
    }
    expect(ps1).not.toMatch(/--unregister\s+['"]?Ubuntu/);
  });

  it.runIf(process.platform === 'win32')(
    'passes its pester-free self-test (pure rules: no wsl.exe call, no download)',
    () => {
      const r = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(ROOT, 'agent', 'scripts', 'throwaway-wsl.ps1'),
          '-SelfTest',
        ],
        { encoding: 'utf8', timeout: 60_000, env: { ...process.env, IA_THROWAWAY_WSL: '' } },
      );
      expect(r.stdout).toMatch(/IA_T2_SELFTEST_FAILED=0/);
      expect(Number(/IA_T2_SELFTEST_PASSED=(\d+)/.exec(r.stdout)?.[1] ?? 0)).toBeGreaterThanOrEqual(25);
      expect(r.status).toBe(0);
    },
  );
});

describe('the WSL harness scripts (section 8.12)', () => {
  const sh = (n) => read(ROOT, 'agent', 'scripts', n);

  it('service-e2e.sh refuses a worker without --no-self-delete and owns the isolation flags', () => {
    const s = sh('service-e2e.sh');
    expect(s).toContain('*" --worker-arg --no-self-delete "*) ;;');
    expect(s).toMatch(
      /--system-bus \| --display \| --runtime-dir \| --session-bus \| --data-dir \| --home \| --console\)/,
    );
    expect(s).toMatch(/env -u WAYLAND_DISPLAY -u DISPLAY -u DBUS_SYSTEM_BUS_ADDRESS/);
    expect(s).toMatch(/--console --data-dir "\$root\/data" --system-bus "\$bus" --display ":\$num"/);
    expect(s).toMatch(/--session-bus none --home "\$root\/home"/);
    expect(s).toMatch(/'' \| 0 \| \*\[!0-9\]\*\) echo "service-e2e: display :\$num is not allowed"/);
  });

  it('logind-fake.sh serves only a private bus in a /tmp directory', () => {
    const s = sh('logind-fake.sh');
    expect(s).toMatch(/dbus-daemon --config-file="\$dir\/bus\.conf" --address="\$address" --nofork --nopidfile/);
    expect(s).toMatch(/\/tmp\/\?\*\) ;;/);
    expect(s).not.toMatch(/\/run\/dbus\/system_bus_socket"?\s*$/m);
    const fake = read(ROOT, 'agent', 'crates', 'ia-service', 'examples', 'logind_fake.rs');
    expect(fake).toMatch(/if !bus\.starts_with\("unix:path="\)/);
  });

  it('pkg-sandbox-test.sh pins Ubuntu Base 22.04 by name and sha256 and runs bubblewrap as the row says', () => {
    const s = sh('pkg-sandbox-test.sh');
    expect(s).toContain('UBUNTU_BASE_FILE="ubuntu-base-22.04.5-base-amd64.tar.gz"');
    expect(s).toMatch(/UBUNTU_BASE_SHA256="[0-9a-f]{64}"/);
    expect(s).toContain('UBUNTU_BASE_URL="https://cdimage.ubuntu.com/ubuntu-base/releases/22.04/release"');
    expect(s).toContain('cache="$HOME/.cache/ia-throwaway"');
    expect(s).toMatch(
      /bwrap --unshare-all --uid 0 --gid 0 \\\s+--bind "\$rootfs" \/ --proc \/proc --dev \/dev --tmpfs \/tmp/,
    );
    expect(s).toMatch(/--die-with-parent/);
    expect(s).toContain("sandbox 'dpkg -i /mnt/pkg/pkg.deb'");
    expect(s).not.toMatch(/sandbox '[^']*--force/); // no dpkg --force-* inside the sandbox
    expect(s).toContain("sandbox 'dpkg --purge indiansassist-agent'");
  });
});

describe('packaging/linux/build.mjs helpers', () => {
  let shared;
  beforeAll(async () => {
    shared = await loadShared();
  });

  it('names the packages as installerFileName does', () => {
    for (const format of ['deb', 'rpm']) {
      expect(packageFileName('0.3.0', format)).toBe(shared.installerFileName('x64', '0.3.0', format));
    }
    expect(packageFileName('0.3.0', 'deb')).toBe('IndiansAssist-Agent-0.3.0-linux-x64.deb');
    expect(() => packageFileName('0.3.0', 'msi')).toThrow();
  });

  it('writes an installer dist manifest the api schema accepts, platform linux', () => {
    const m = distManifest('0.3.0', [
      { format: 'deb', size: 7, sha256: HEX, file: packageFileName('0.3.0', 'deb') },
      { format: 'rpm', size: 8, sha256: HEX, file: packageFileName('0.3.0', 'rpm') },
    ]);
    const parsed = shared.installerDistManifestSchema.parse(m);
    expect(parsed.builds.map((b) => [b.platform, b.format, b.arch, b.signed])).toEqual([
      ['linux', 'deb', 'x64', false],
      ['linux', 'rpm', 'x64', false],
    ]);
    // The wire row (without `file`) is an installerBuildSchema too.
    const { file: _file, ...wire } = m.builds[0];
    expect(shared.installerBuildSchema.parse(wire).platform).toBe('linux');
    expect(MIN_OS.length).toBeLessThanOrEqual(64);
  });

  it('writes the installed-file manifest the service reads (ia_service::config::InstallManifest)', () => {
    const m = installManifest('0.3.0', [
      { name: 'ia-service', size: 1, sha256: HEX, extra: 'dropped' },
      { name: 'ia-desktop', size: 2, sha256: HEX },
    ]);
    expect(m).toEqual({
      v: 1,
      version: '0.3.0',
      arch: ARCH,
      placeholder: false,
      files: [
        { name: 'ia-service', size: 1, sha256: HEX },
        { name: 'ia-desktop', size: 2, sha256: HEX },
      ],
    });
  });

  it('maps Windows paths into WSL and reads the workspace version', () => {
    expect(toWslPath('C:\\xampp\\htdocs\\indiansassist.com\\packaging\\linux')).toBe(
      '/mnt/c/xampp/htdocs/indiansassist.com/packaging/linux',
    );
    expect(() => toWslPath('relative\\path')).toThrow();
    expect(workspaceVersion('[workspace.package]\nversion = "1.2.3"\n')).toBe('1.2.3');
    expect(() => workspaceVersion('[workspace.package]\nversion = "1.2"\n')).toThrow();
    expect(sha256Line(HEX, 'a.deb')).toBe(`${HEX}  a.deb\n`);
  });
});
