/**
 * Package 3 e2e harness: locate and drive the native Rust agent (the Desk) as a child process.
 *
 * The dev agent binary (`cargo build -p ia-agent --features dev`, GUI/console build) joins a live P3 session as
 * the native Desk. The spec spawns it with the short code the console minted, `--api-origin` pointing at the
 * e2e API, `--synthetic-capture` (deterministic frames, no display), `--auto-consent control` (skip the egui
 * consent window) and `--no-self-delete` (never remove the test binary). It prints its security code (SAS) and
 * lifecycle milestones to stdout/stderr; this harness captures those lines so the spec can assert the SAS the
 * agent derived equals the one the console shows, and that Stop / teardown / the self-delete decision are logged.
 *
 * Processes are tracked by PID and killed with `taskkill /PID <pid> /T /F` on teardown; the harness never kills a
 * process it did not start.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The built dev agent binary, release preferred over debug. Honours AGENT_BIN if set. */
export function resolveAgentBinary(): string {
  const override = process.env.AGENT_BIN;
  if (override && existsSync(override)) return override;
  const candidates = [
    resolve(repoRoot, 'agent/target/release/IndiansAssist.exe'),
    resolve(repoRoot, 'agent/target/debug/IndiansAssist.exe'),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found)
    throw new Error(
      `agent binary not found; build it with \`pnpm agent:build:dev\` (looked at: ${candidates.join(', ')})`,
    );
  return found;
}

export type AgentOptions = {
  code: string;
  apiOrigin: string;
  autoConsent?: 'view' | 'control' | 'elevated';
  stopAfterSecs?: number;
  extraArgs?: string[];
};

/** A running agent process with line-oriented log access. */
export class AgentProcess {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly lines: string[] = [];
  private readonly waiters: { re: RegExp; resolve: (m: RegExpMatchArray) => void }[] = [];

  constructor(binary: string, opts: AgentOptions) {
    const args = [
      '--code',
      opts.code,
      '--api-origin',
      opts.apiOrigin,
      '--synthetic-capture',
      '--auto-consent',
      opts.autoConsent ?? 'control',
      '--no-self-delete',
      ...(opts.stopAfterSecs ? ['--stop-after', String(opts.stopAfterSecs)] : []),
      ...(opts.extraArgs ?? []),
    ];
    this.proc = spawn(binary, args, {
      cwd: repoRoot,
      // `info` so the SAS and lifecycle lines are emitted; the agent logs via tracing to stderr.
      env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? 'ia_agent=info,info' },
    }) as ChildProcessWithoutNullStreams;
    const onChunk = (buf: Buffer) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line) continue;
        this.lines.push(line);
        console.log(`[agent] ${line}`);
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          const m = line.match(this.waiters[i]!.re);
          if (m) {
            this.waiters.splice(i, 1)[0]!.resolve(m);
          }
        }
      }
    };
    this.proc.stdout.on('data', onChunk);
    this.proc.stderr.on('data', onChunk);
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  /** Resolve when a log line matches `re`, or reject after `timeoutMs`. Scans lines already seen first. */
  waitForLine(re: RegExp, timeoutMs = 30_000): Promise<RegExpMatchArray> {
    for (const line of this.lines) {
      const m = line.match(re);
      if (m) return Promise.resolve(m);
    }
    return new Promise((resolveP, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.re === re);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`agent log did not match ${re} within ${timeoutMs}ms`));
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

  /** The six-digit security code the agent derived (e.g. a line "security code 483 920" / "SAS 483 920"). */
  async waitForSas(timeoutMs = 30_000): Promise<string> {
    const m = await this.waitForLine(/(?:security code|SAS)\s+(\d{3})\s?(\d{3})/i, timeoutMs);
    return `${m[1]}${m[2]}`;
  }

  waitForExit(timeoutMs = 20_000): Promise<number | null> {
    if (this.proc.exitCode !== null) return Promise.resolve(this.proc.exitCode);
    return new Promise((resolveP, reject) => {
      const timer = setTimeout(() => reject(new Error(`agent did not exit within ${timeoutMs}ms`)), timeoutMs);
      this.proc.once('exit', (code) => {
        clearTimeout(timer);
        resolveP(code);
      });
    });
  }

  /**
   * Ask the agent to Stop. The dev console build treats a `stop` line on stdin as a graceful
   * Stop. (On Windows `child.kill('SIGINT')` unconditionally terminates the process, so it
   * would skip the agent's teardown and self-delete log; stdin is the portable trigger.)
   */
  interrupt(): void {
    if (this.proc.exitCode !== null) return;
    try {
      this.proc.stdin.write('stop\n');
    } catch {
      /* stdin may be closed */
    }
  }

  /** Hard-kill the process tree by PID (only this process, which we started). */
  kill(): void {
    const pid = this.proc.pid;
    if (pid === undefined || this.proc.exitCode !== null) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
    else this.proc.kill('SIGKILL');
  }
}

export function spawnAgent(opts: AgentOptions): AgentProcess {
  return new AgentProcess(resolveAgentBinary(), opts);
}
