/**
 * `pnpm e2e:p3:linux` harness (docs/specs/phase-e-contracts.md section 7.10 "End to end"): drive the Linux dev agent,
 * built and run inside WSL Ubuntu, as the Desk of a P3 session whose Assist is a Windows browser.
 *
 * WSL runs in NAT mode, so the agent reaches the Windows-hosted api at the WSL default gateway (`ip route show
 * default`, read by run-p3-linux.mjs and passed as E2E_LINUX_GW). The agent is started through
 * `agent/scripts/e2e-agent.sh`, which applies the binding isolation: WAYLAND_DISPLAY unset (the wayland mode sets a
 * name that names no compositor), DISPLAY a harness-owned Xvfb or unset, a temporary XDG root and download folder,
 * no session bus, and `--no-self-delete` always. Nothing is ever sent to, or captured from, the user's desktop.
 *
 * Processes: the harness kills only what it started (the wsl.exe child by PID, then the script's own pid list in WSL
 * through `e2e-agent.sh cleanup <root>`).
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** `C:\xampp\...` -> `/mnt/c/xampp/...` (the WSL view of a Windows path). */
export function wslPath(winPath: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) return winPath.replace(/\\/g, '/');
  return `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}`;
}

export const WSL_DISTRO = process.env.E2E_WSL_DISTRO || 'Ubuntu';
const SCRIPT = wslPath(resolve(repoRoot, 'agent/scripts/e2e-agent.sh'));

/** Run a short command in WSL and return its stdout (never a shell string: argv only). */
export function wsl(args: string[], timeoutMs = 30_000): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('wsl.exe', ['-d', WSL_DISTRO, '--', ...args], { encoding: 'utf8', timeout: timeoutMs });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export type LinuxMode = 'synthetic' | 'x11' | 'wayland';

export type LinuxAgentOptions = {
  mode: LinuxMode;
  code: string;
  apiOrigin: string;
  stopAfterSecs?: number;
};

/** A running Linux agent (through wsl.exe) with line-oriented log access. */
export class LinuxAgent {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly lines: string[] = [];
  root: string | null = null;
  display: string | null = null;
  private readonly waiters: { re: RegExp; resolve: (m: RegExpMatchArray) => void }[] = [];

  constructor(opts: LinuxAgentOptions) {
    const args = [
      '--code',
      opts.code,
      '--api-origin',
      opts.apiOrigin,
      ...(opts.mode === 'synthetic' ? ['--synthetic-capture'] : []),
      '--auto-consent',
      'control',
      '--no-self-delete',
      ...(opts.stopAfterSecs ? ['--stop-after', String(opts.stopAfterSecs)] : []),
    ];
    this.proc = spawn('wsl.exe', ['-d', WSL_DISTRO, '--', 'bash', SCRIPT, opts.mode, ...args], {
      env: {
        ...process.env,
        IA_E2E_XVFB_DISPLAY: process.env.E2E_LINUX_XVFB_DISPLAY || '96',
        // WSLENV carries just this one variable into WSL (nothing else of the Windows environment).
        WSLENV: ['IA_E2E_XVFB_DISPLAY/u', process.env.WSLENV].filter(Boolean).join(':'),
      },
    }) as ChildProcessWithoutNullStreams;
    const onChunk = (buf: Buffer) => {
      for (const raw of buf.toString('utf8').split(/\r?\n/)) {
        const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
        if (!line) continue;
        this.lines.push(line);
        console.log(`[linux-agent] ${line}`);
        const root = /^E2E_ROOT=(\/tmp\/ia-e2e-agent\.[A-Za-z0-9]+)$/.exec(line);
        if (root) this.root = root[1]!;
        const disp = /^E2E_DISPLAY=(:\d+)$/.exec(line);
        if (disp) this.display = disp[1]!;
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          const m = line.match(this.waiters[i]!.re);
          if (m) this.waiters.splice(i, 1)[0]!.resolve(m);
        }
      }
    };
    this.proc.stdout.on('data', onChunk);
    this.proc.stderr.on('data', onChunk);
  }

  waitForLine(re: RegExp, timeoutMs = 30_000): Promise<RegExpMatchArray> {
    for (const line of this.lines) {
      const m = line.match(re);
      if (m) return Promise.resolve(m);
    }
    return new Promise((resolveP, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.re === re);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`linux agent log did not match ${re} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({
        re,
        resolve: (m) => {
          clearTimeout(timer);
          resolveP(m);
        },
      });
    });
  }

  async waitForSas(timeoutMs = 30_000): Promise<string> {
    const m = await this.waitForLine(/(?:security code|SAS)\s+(\d{3})\s?(\d{3})/i, timeoutMs);
    return `${m[1]}${m[2]}`;
  }

  /** The dev `stop` line on stdin (relayed by e2e-agent.sh to the agent). */
  interrupt(): void {
    if (this.proc.exitCode !== null) return;
    try {
      this.proc.stdin.write('stop\n');
    } catch {
      /* stdin may be closed */
    }
  }

  /** sha256 of a file the agent wrote, read inside WSL; only paths under this run's temporary root. */
  sha256Of(path: string): string {
    if (!this.root || !path.startsWith(`${this.root}/`)) throw new Error(`refusing to read ${path} outside ${this.root}`);
    const r = wsl(['sha256sum', path]);
    return r.stdout.trim().split(/\s+/)[0] ?? '';
  }

  /** The pointer position on the harness Xvfb, read by xdotool as an independent observer (x11 mode only). */
  pointerOnXvfb(): { x: number; y: number } | null {
    if (!this.display || this.display === ':0') return null;
    const r = wsl(['env', '-u', 'WAYLAND_DISPLAY', `DISPLAY=${this.display}`, 'xdotool', 'getmouselocation']);
    const m = /x:(\d+)\s+y:(\d+)/.exec(r.stdout);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  }

  /** Stop what this run started: the wsl.exe child, then the script's own pids and temporary root in WSL. */
  kill(): void {
    if (this.proc.exitCode === null && this.proc.pid !== undefined) {
      spawnSync('taskkill', ['/PID', String(this.proc.pid), '/T', '/F']);
    }
    if (this.root) wsl(['bash', SCRIPT, 'cleanup', this.root]);
  }
}

/** Build the dev agent (and the Xvfb monitor helper) inside WSL. */
export function buildLinuxAgent(): void {
  const r = spawnSync('wsl.exe', ['-d', WSL_DISTRO, '--', 'bash', SCRIPT, 'build'], { stdio: 'inherit', timeout: 1_800_000 });
  if (r.status !== 0) throw new Error(`linux agent build failed (${r.status})`);
}
