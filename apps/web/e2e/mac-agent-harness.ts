/**
 * `pnpm e2e:p3:mac` harness (docs/specs/phase-f-contracts.md sections 17.5, 17.6): drive the macOS dev agent as the
 * Desk of a P3 session whose Assist is a Chromium on the same Mac.
 *
 * Isolation (A1-A3, S1, S7): the agent always runs with `--synthetic-capture --no-self-delete`, so nothing is captured
 * from the screen and the no-op input sink posts nothing to the desktop; TCC is never touched. HOME and TMPDIR point at
 * a temporary root this run creates, so received files (`$HOME/Downloads/IndiansAssist`), the support directory, the
 * playbook run directory and the single-instance socket all live inside it. IA_ICE_LOOPBACK=1 keeps WebRTC on
 * 127.0.0.1, where the macOS application firewall does not filter, so no prompt appears. Playbooks are read-only.
 *
 * Processes: the harness kills only what it started (its own child), then removes its own temporary root.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
/** run-p3-mac.mjs builds into a target directory of its own, so the release bundle's binary is never replaced. */
export const MAC_AGENT_BIN = process.env.MAC_AGENT_BIN || resolve(repoRoot, 'agent/target/e2e-mac/release/IndiansAssist');

/**
 * The read-only playbook catalogue of this suite (S1): each body only reads or prints. `zsh` is the macOS agent's
 * default interpreter (section 17.2).
 */
export const MAC_PLAYBOOKS = [
  {
    name: 'Mac e2e: say where I am',
    description: 'Read-only: prints its parameter, its working directory and the kernel name.',
    interpreter: 'zsh' as const,
    body: 'echo "who=$IA_PARAM_WHO"\necho "cwd=$(pwd)"\necho "uname=$(uname -s)"\necho "shell=$ZSH_NAME"\n',
    requiresElevation: false,
    timeoutSec: 30,
    parameters: [{ name: 'who', label: 'Who', type: 'string', required: false, pattern: '[A-Za-z0-9 ]{1,40}', default: 'e2e' }],
  },
];

export type MacAgentOptions = {
  code: string;
  apiOrigin: string;
  stopAfterSecs?: number;
};

/** A running macOS dev agent with line-oriented log access. */
export class MacAgent {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly lines: string[] = [];
  /** This run's temporary root (realpath, so it compares with what the agent prints). */
  readonly root: string;
  private readonly waiters: { re: RegExp; resolve: (m: RegExpMatchArray) => void }[] = [];

  constructor(opts: MacAgentOptions) {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), 'ia-e2e-mac.')));
    for (const d of ['home/Downloads', 'tmp']) mkdirSync(join(this.root, d), { recursive: true });
    const args = [
      '--code',
      opts.code,
      '--api-origin',
      opts.apiOrigin,
      '--synthetic-capture',
      '--auto-consent',
      'control',
      '--no-self-delete',
      ...(opts.stopAfterSecs ? ['--stop-after', String(opts.stopAfterSecs)] : []),
    ];
    this.proc = spawn(MAC_AGENT_BIN, args, {
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: join(this.root, 'home'),
        TMPDIR: `${join(this.root, 'tmp')}/`,
        IA_ICE_LOOPBACK: '1',
        RUST_LOG: process.env.E2E_MAC_RUST_LOG || 'info',
        LANG: 'en_US.UTF-8',
      },
    }) as ChildProcessWithoutNullStreams;
    const onChunk = (buf: Buffer) => {
      for (const raw of buf.toString('utf8').split(/\r?\n/)) {
        const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
        if (!line) continue;
        this.lines.push(line);
        console.log(`[mac-agent] ${line}`);
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          const m = line.match(this.waiters[i]!.re);
          if (m) this.waiters.splice(i, 1)[0]!.resolve(m);
        }
      }
    };
    this.proc.stdout.on('data', onChunk);
    this.proc.stderr.on('data', onChunk);
  }

  /** `$HOME/Downloads/IndiansAssist` inside this run's root. */
  get downloads(): string {
    return join(this.root, 'home/Downloads/IndiansAssist');
  }

  /** The playbook run directory (`$TMPDIR/IndiansAssist/run`) inside this run's root. */
  get runDir(): string {
    return join(this.root, 'tmp/IndiansAssist/run');
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
        reject(new Error(`mac agent log did not match ${re} within ${timeoutMs}ms`));
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

  /** The dev `stop` line on stdin. */
  interrupt(): void {
    if (this.proc.exitCode !== null) return;
    try {
      this.proc.stdin.write('stop\n');
    } catch {
      /* stdin may be closed */
    }
  }

  /** sha256 of a file the agent wrote; only paths inside this run's temporary root. */
  sha256Of(path: string): string {
    if (!path.startsWith(`${this.root}/`)) throw new Error(`refusing to read ${path} outside ${this.root}`);
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }

  /** Stop the child this run started, then remove this run's temporary root. */
  kill(): void {
    if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
    rmSync(this.root, { recursive: true, force: true });
  }
}
