// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Capture } from '../src/content/capture';
import { replayInput } from '../src/content/input-replay';

const policy = { maskSelectors: [], blockSelectors: [], titlePrefix: true, allowUnmask: true };
const bar = { technician: 'Asha', org: 'Acme', relayed: false, recording: false, debuggerAttached: false, backstage: false, backstageCount: 0, paused: false, revealed: false };

function fakeRuntime() {
  const posted: unknown[] = [];
  const toWorker: Record<string, unknown>[] = [];
  const ports: { onMessage: { listeners: ((m: unknown) => void)[] }; onDisconnect: { listeners: (() => void)[] }; disconnect: () => void }[] = [];
  const rt = {
    connectFails: false,
    connect: vi.fn(() => {
      if (rt.connectFails) throw new Error('Could not establish connection');
      const port = {
        name: 'ia.mirror',
        onMessage: { listeners: [] as ((m: unknown) => void)[], addListener(l: (m: unknown) => void) { this.listeners.push(l); } },
        onDisconnect: { listeners: [] as (() => void)[], addListener(l: () => void) { this.listeners.push(l); } },
        postMessage: (m: unknown) => posted.push(m),
        disconnect: vi.fn(),
      };
      ports.push(port);
      return port as unknown as chrome.runtime.Port;
    }),
    sendMessage: vi.fn(async (m: unknown) => void toWorker.push(m as Record<string, unknown>)),
  };
  return { rt, posted, toWorker, ports };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  document.title = 'Page';
  document.documentElement.querySelectorAll('ia-indicator').forEach((n) => n.remove());
});

describe('capture lifecycle (section 9.2)', () => {
  it('is inert until cs.start: no Port, no DOM change; announces itself without a URL', () => {
    const f = fakeRuntime();
    const c = new Capture(document, window, f.rt);
    c.announce();
    expect(f.toWorker).toEqual([{ t: 'cs.ready', to: 'worker' }]);
    expect(f.rt.connect).not.toHaveBeenCalled();
    expect(document.querySelector('ia-indicator')).toBeNull();
    expect(c.handleWorker({ to: 'content', t: 'cs.input', op: 'input.key', args: {} })).toMatchObject({ ok: false });
  });

  it('cs.start opens the Port, mounts the bar, prefixes the title and starts recording; cs.stop undoes it all', async () => {
    document.title = 'Form';
    const f = fakeRuntime();
    const stopped = vi.fn();
    const c = new Capture(document, window, f.rt, stopped);
    c.handleWorker({ to: 'content', t: 'cs.start', policy, bar, level: 'view' });
    await new Promise((r) => setTimeout(r, 10));
    expect(f.rt.connect).toHaveBeenCalledWith({ name: 'ia.mirror' });
    expect(document.querySelector('ia-indicator')).not.toBeNull();
    expect(document.title).toBe('(Shared) Form');
    expect(c.state).toBe('running');
    expect(c.recorder.running).toBe(true);
    // focus the tab: the snapshot taken at start goes out on the Port
    f.ports[0]!.onMessage.listeners.forEach((l) => l({ t: 'oc.focus', focused: true }));
    expect(f.posted.some((m) => (m as { t: string; snapshot: boolean }).t === 'cs.events' && (m as { snapshot: boolean }).snapshot)).toBe(true);
    c.handleWorker({ to: 'content', t: 'cs.stop' });
    expect(document.querySelector('ia-indicator')).toBeNull();
    expect(document.title).toBe('Form');
    expect(c.recorder.running).toBe(false);
    expect(stopped).toHaveBeenCalled();
  });

  it('stops on its own when the Port is lost and cannot be re-opened within 5 s', async () => {
    const f = fakeRuntime();
    const c = new Capture(document, window, f.rt);
    c.handleWorker({ to: 'content', t: 'cs.start', policy, bar, level: 'view' });
    await new Promise((r) => setTimeout(r, 10));
    vi.useFakeTimers();
    f.rt.connectFails = true;
    f.ports[0]!.onDisconnect.listeners.forEach((l) => l());
    vi.advanceTimersByTime(4000);
    expect(c.state).toBe('running');
    vi.advanceTimersByTime(2000);
    expect(c.state).toBe('stopped');
    expect(document.querySelector('ia-indicator')).toBeNull();
  });

  it('pause stops the recorder and shows the paused bar; resume records again', async () => {
    const f = fakeRuntime();
    const c = new Capture(document, window, f.rt);
    c.handleWorker({ to: 'content', t: 'cs.start', policy, bar, level: 'in_page' });
    await new Promise((r) => setTimeout(r, 10));
    c.handleWorker({ to: 'content', t: 'cs.pause' });
    expect(c.state).toBe('paused');
    expect(c.recorder.running).toBe(false);
    expect(c.bar?.textForTest()).toContain('Paused: not shared');
    expect(c.handleWorker({ to: 'content', t: 'cs.input', op: 'input.key', args: { kind: 'press', key: 'a', code: 'KeyA', modifiers: {} } })).toMatchObject({ ok: false });
    c.handleWorker({ to: 'content', t: 'cs.resume' });
    expect(c.state).toBe('running');
    expect(c.recorder.running).toBe(true);
    c.stop();
  });

  it('a tab reveal ends at the TTL with cs.revealEnded', async () => {
    const f = fakeRuntime();
    const c = new Capture(document, window, f.rt);
    c.handleWorker({ to: 'content', t: 'cs.start', policy, bar, level: 'view' });
    await new Promise((r) => setTimeout(r, 10));
    vi.useFakeTimers();
    expect(c.handleWorker({ to: 'content', t: 'cs.unmask', scope: 'tab', nodeId: null })).toMatchObject({ ok: true, label: 'all hidden fields on this tab' });
    c.handleWorker({ to: 'content', t: 'cs.unmaskDecision', granted: true, ttlMs: 60000 });
    expect(c.unmask.active).toBe(true);
    vi.advanceTimersByTime(60001);
    expect(c.unmask.active).toBe(false);
    expect(f.toWorker.at(-1)).toMatchObject({ t: 'cs.revealEnded', scope: 'tab', by: 'ttl' });
    c.stop();
  });
});

describe('input replay (section 5.4)', () => {
  it('dispatches pointer sequences, fills through the value setter and refuses frame hits', () => {
    const btn = document.createElement('button');
    const input = document.createElement('input');
    const frame = document.createElement('iframe');
    document.body.append(btn, input, frame);
    const seen: string[] = [];
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) btn.addEventListener(t, () => seen.push(t));
    const nodes = new Map<number, Node>([
      [1, btn],
      [2, input],
    ]);
    const lookup = (id: number) => nodes.get(id) ?? null;
    const hits: Element[] = [btn, frame];
    document.elementFromPoint = vi.fn(() => hits.shift() ?? null);
    const mods = { alt: false, ctrl: false, meta: false, shift: false };
    expect(replayInput('input.pointer', { kind: 'click', nodeId: 1, nx: 0.5, ny: 0.5, vx: 0, vy: 0, modifiers: mods }, lookup, document, window)).toMatchObject({ ok: true });
    expect(seen).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    expect(replayInput('input.pointer', { kind: 'click', nodeId: null, vx: 0.5, vy: 0.5, modifiers: mods }, lookup, document, window)).toEqual({ ok: false, error: 'not_supported', message: 'cross-origin frame' });
    const changes: string[] = [];
    input.addEventListener('input', () => changes.push('input'));
    input.addEventListener('change', () => changes.push('change'));
    expect(replayInput('input.fill', { nodeId: 2, value: 'hello', commit: true }, lookup, document, window)).toEqual({ ok: true, applied: true });
    expect(input.value).toBe('hello');
    expect(changes).toEqual(['input', 'change']);
    hits.push(btn);
    expect(replayInput('input.pointer', { kind: 'click', nodeId: null, vx: 0.2, vy: 0.4, modifiers: mods, mode: 'debugger' }, lookup, document, window)).toEqual({ ok: true, cx: 0.2 * window.innerWidth, cy: 0.4 * window.innerHeight });
  });
});
