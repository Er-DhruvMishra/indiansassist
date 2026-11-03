/**
 * Phase F sections 7.6 and 15.6: the app-shell worker in isolation (a fake `caches` and `fetch`): every section 7.6c
 * path and every non-GET passes through; nothing that is not a plain 200 (or that says no-store) is cached; old shell
 * caches are removed; assets are cache-first; `/app` navigations are network-first with the cached shell as the
 * offline fallback. Also the build step: the emitted `/sw.js` is a classic script carrying the build's asset list.
 */
import { describe, expect, it, vi } from 'vitest';
import { cacheable, createShellWorker, routeOf, SHELL_FILES } from '../src/sw';
import { shellWorker } from '../vite.config';

const ORIGIN = 'https://console.example.test';

function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      match: async (req: Request | string) => m.get(typeof req === 'string' ? req : new URL(req.url).pathname)?.clone(),
      put: async (req: Request | string, res: Response) => void m.set(typeof req === 'string' ? req : new URL(req.url).pathname, res),
      addAll: async () => undefined,
    };
  };
  return {
    stores,
    caches: { open, keys: async () => [...stores.keys()], delete: async (k: string) => stores.delete(k) },
  };
}

const req = (path: string, init: RequestInit & { mode?: RequestMode } = {}) => {
  const { mode, ...rest } = init;
  const r = new Request(path.startsWith('http') ? path : `${ORIGIN}${path}`, rest);
  // Node's Request has no navigate mode; a navigation is modelled by overriding `mode`.
  if (mode === 'navigate') Object.defineProperty(r, 'mode', { value: 'navigate' });
  return r;
};

describe('routing (section 7.6c)', () => {
  it('passes every listed path, every non-GET and every cross-origin request through untouched', () => {
    const pass = ['/api/v1/auth/me', '/api', '/signal', '/download/agent', '/downloads', '/.well-known/assetlinks.json', '/replayer.html', '/room', '/room/abc', '/join', '/join?x=1', '/invite', '/reset', '/c', '/c/ABCD1234EFGH', '/sso/continue', '/', '/login', '/favicon.svg', '/sw.js'];
    for (const p of pass) {
      expect(routeOf(req(p), ORIGIN), p).toBe('pass');
      expect(routeOf(req(p, { mode: 'navigate' }), ORIGIN), `${p} (navigation)`).toBe('pass');
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      expect(routeOf({ method, url: `${ORIGIN}/assets/a.js`, mode: 'cors' }, ORIGIN)).toBe('pass');
    expect(routeOf(req('https://cdn.example.test/assets/a.js'), ORIGIN)).toBe('pass');
    expect(routeOf(req('https://cdn.example.test/app/', { mode: 'navigate' }), ORIGIN)).toBe('pass');
  });

  it('handles same-origin assets and /app navigations only', () => {
    expect(routeOf(req('/assets/index-abc.js'), ORIGIN)).toBe('asset');
    expect(routeOf(req('/app', { mode: 'navigate' }), ORIGIN)).toBe('navigation');
    expect(routeOf(req('/app/sessions/1', { mode: 'navigate' }), ORIGIN)).toBe('navigation');
    // A fetch (not a navigation) of an /app URL is not the shell's business.
    expect(routeOf(req('/app/sessions/1'), ORIGIN)).toBe('pass');
  });

  it('caches only plain 200 responses without no-store', () => {
    expect(cacheable(new Response('x', { status: 200 }))).toBe(true);
    expect(cacheable(new Response('x', { status: 404 }))).toBe(false);
    expect(cacheable(new Response('x', { status: 206 }))).toBe(false);
    expect(cacheable(new Response('x', { status: 200, headers: { 'Cache-Control': 'private, no-store' } }))).toBe(false);
    expect(cacheable(new Response('x', { status: 200, headers: { 'Cache-Control': 'no-cache' } }))).toBe(true);
    const opaque = new Response(null, { status: 200 });
    Object.defineProperty(opaque, 'type', { value: 'opaque' });
    expect(cacheable(opaque)).toBe(false);
  });
});

describe('the worker (sections 7.6b-d)', () => {
  it('install precaches the shell and this build only, skipping non-200 and no-store answers', async () => {
    const { stores, caches } = fakeCaches();
    const fetch = vi.fn(async (r: Request) => {
      const p = new URL(r.url).pathname;
      if (p === '/icons/icon-512.png') return new Response('missing', { status: 404 });
      if (p === '/assets/b.css') return new Response('b', { status: 200, headers: { 'Cache-Control': 'no-store' } });
      return new Response(`body of ${p}`, { status: 200 });
    });
    const w = createShellWorker({ caches, fetch, origin: ORIGIN, buildId: 'b1', assets: ['/assets/a.js', '/assets/b.css', '/api/not-an-asset'] });
    await w.install();
    const cached = [...(stores.get('ia-shell-b1')?.keys() ?? [])].sort();
    expect(cached).toEqual(['/assets/a.js', '/icons/icon-192.png', '/index.html', '/manifest.webmanifest']);
    expect(fetch.mock.calls.map(([r]) => new URL(r.url).pathname)).not.toContain('/api/not-an-asset');
    expect(SHELL_FILES).toContain('/index.html');
  });

  it('activate deletes every other shell cache and nothing else', async () => {
    const { stores, caches } = fakeCaches();
    for (const k of ['ia-shell-old1', 'ia-shell-old2', 'ia-shell-b2', 'someone-else']) await caches.open(k);
    const w = createShellWorker({ caches, fetch: vi.fn(), origin: ORIGIN, buildId: 'b2', assets: [] });
    await w.activate();
    expect([...stores.keys()].sort()).toEqual(['ia-shell-b2', 'someone-else']);
  });

  it('serves assets cache-first and stores only cacheable ones', async () => {
    const { stores, caches } = fakeCaches();
    let n = 0;
    const fetch = vi.fn(async (r: Request) => {
      n += 1;
      const p = new URL(r.url).pathname;
      return p.endsWith('nostore.js') ? new Response('x', { status: 200, headers: { 'Cache-Control': 'no-store' } }) : new Response(`v${n}`, { status: 200 });
    });
    const w = createShellWorker({ caches, fetch, origin: ORIGIN, buildId: 'b3', assets: [] });
    expect(await (await w.handle(req('/assets/a.js'))!).text()).toBe('v1');
    expect(await (await w.handle(req('/assets/a.js'))!).text()).toBe('v1');
    expect(fetch).toHaveBeenCalledTimes(1);
    await w.handle(req('/assets/nostore.js'));
    await w.handle(req('/assets/nostore.js'));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(stores.get('ia-shell-b3')?.has('/assets/nostore.js')).toBe(false);
  });

  it('navigations are network-first; offline or after the timeout the cached shell answers', async () => {
    const { caches } = fakeCaches();
    const shell = await caches.open('ia-shell-b4');
    await shell.put('/index.html', new Response('<shell>', { status: 200 }));
    let mode: 'ok' | 'down' | 'hang' = 'ok';
    const fetch = vi.fn((r: Request) => {
      if (mode === 'ok') return Promise.resolve(new Response(`network ${new URL(r.url).pathname}`, { status: 200 }));
      if (mode === 'down') return Promise.reject(new TypeError('Failed to fetch'));
      return new Promise<Response>(() => undefined);
    });
    const w = createShellWorker({ caches, fetch, origin: ORIGIN, buildId: 'b4', assets: [], timeoutMs: 20 });
    expect(await (await w.handle(req('/app/sessions', { mode: 'navigate' }))!).text()).toBe('network /app/sessions');
    mode = 'down';
    expect(await (await w.handle(req('/app/sessions', { mode: 'navigate' }))!).text()).toBe('<shell>');
    mode = 'hang';
    expect(await (await w.handle(req('/app', { mode: 'navigate' }))!).text()).toBe('<shell>');
  });

  it('never answers an API call, even offline', async () => {
    const { caches } = fakeCaches();
    const fetch = vi.fn(() => Promise.reject(new TypeError('offline')));
    const w = createShellWorker({ caches, fetch, origin: ORIGIN, buildId: 'b5', assets: [] });
    for (const p of ['/api/v1/auth/me', '/api/v1/sessions', '/signal'])
      for (const method of ['GET', 'POST']) expect(w.handle(req(p, method === 'POST' ? { method, body: '{}' } : {}))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the build step (section 7.6a)', () => {
  it('emits /sw.js as a classic script with the build id and the hashed asset list', () => {
    const plugin = shellWorker();
    const emitted: { fileName: string; source: string }[] = [];
    const bundle = { 'assets/index-abc.js': {}, 'assets/index-abc.js.map': {}, 'assets/index-def.css': {}, 'index.html': {} };
    (plugin.generateBundle as unknown as (this: unknown, o: unknown, b: unknown) => void).call({ emitFile: (f: { fileName: string; source: string }) => emitted.push(f) }, {}, bundle);
    expect(emitted).toHaveLength(1);
    const sw = emitted[0]!;
    expect(sw.fileName).toBe('sw.js');
    expect(sw.source).toContain('"/assets/index-abc.js"');
    expect(sw.source).toContain('"/assets/index-def.css"');
    expect(sw.source).not.toContain('.map"');
    expect(sw.source).not.toMatch(/^\s*(import|export)\s/m);
    expect(sw.source).not.toMatch(/addEventListener\(['"](push|sync|periodicsync|message)['"]/);
    // It parses as a classic script.
    expect(() => new Function(sw.source)).not.toThrow();
  });
});
