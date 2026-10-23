// Step runner for the smoke test: prints PASS / FAIL / SKIP per step. A failing `critical` step (the default)
// makes every later step SKIP, because later steps depend on its state; a non-critical failure is reported and
// counted but the run continues.

export class Runner {
  /** @param {{ log?: (line: string) => void }} [opts] */
  constructor(opts = {}) {
    this.log = opts.log ?? ((line) => console.log(line));
    this.results = [];
    this.aborted = null;
  }

  /**
   * Runs `fn` as one step. The value returned by `fn` may be a string (printed as the step detail).
   * @param {string} name
   * @param {() => Promise<string | void> | string | void} fn
   * @param {{ critical?: boolean }} [opts]
   */
  async step(name, fn, opts = {}) {
    const critical = opts.critical ?? true;
    if (this.aborted) {
      this.#record(name, 'SKIP', `after failure of "${this.aborted}"`);
      return undefined;
    }
    const t0 = Date.now();
    try {
      const detail = await fn();
      this.#record(name, 'PASS', typeof detail === 'string' ? detail : '', Date.now() - t0);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#record(name, 'FAIL', msg, Date.now() - t0);
      if (critical) this.aborted = name;
      return false;
    }
  }

  get failed() {
    return this.results.filter((r) => r.status === 'FAIL').length;
  }

  get ok() {
    return this.failed === 0 && this.results.every((r) => r.status === 'PASS');
  }

  summary() {
    const count = (s) => this.results.filter((r) => r.status === s).length;
    return `${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped`;
  }

  #record(name, status, detail, ms) {
    this.results.push({ name, status, detail, ms });
    const time = ms === undefined ? '' : ` (${ms} ms)`;
    this.log(`${status.padEnd(4)}  ${name}${time}${detail ? ` - ${detail}` : ''}`);
  }
}

/** Throws `message` unless `cond` holds. */
export function check(cond, message) {
  if (!cond) throw new Error(message);
}

/** Throws unless `actual === expected`. */
export function eq(actual, expected, what) {
  if (actual !== expected)
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
