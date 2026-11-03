/**
 * Phase F section 7.6: the Assist console's service worker, app shell only (hand-written, no dependency; W121).
 * Built to `/sw.js` by the `ia-shell-worker` plugin in `vite.config.ts`, which prepends this build's id and hashed
 * asset list (`IA_SW_BUILD`, `IA_SW_ASSETS`); registered from `main.tsx` only in production and only on `/app` routes.
 *
 * 7.6b `install` precaches `/index.html`, this build's `/assets/*`, the manifest and the icons into `ia-shell-<build>`;
 *      `activate` deletes every other `ia-shell-*` cache.
 * 7.6c `fetch` handles only same-origin GETs: `/assets/*` cache-first; navigations under `/app` network-first with a
 *      4 s timeout, falling back to the cached `/index.html`. Everything else passes through untouched (no
 *      `respondWith`): `/api/*`, `/signal`, `/download*`, `/.well-known/*`, `/replayer.html`, `/room*`, `/join*`,
 *      `/invite`, `/reset`, `/c*`, `/sso*`, every non-GET and every cross-origin request.
 * 7.6d Nothing is cached that is not a `200`, is opaque, or says `Cache-Control: no-store`; there is no `push`,
 *      `sync`, `periodicsync` or `message` handler, so no data is ever cached and signing out needs no clearing.
 *
 * The logic is `createShellWorker`, pure over injected `caches` and `fetch`, so it is tested in isolation
 * (`test/serviceWorker.test.ts`); the bottom of the file wires it to the worker's events.
 */

export const SHELL_PREFIX = 'ia-shell-';
export const NAV_TIMEOUT_MS = 4000;
export const SHELL_FILES = ['/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

type CacheLike = {
  match(req: Request | string): Promise<Response | undefined>;
  put(req: Request | string, res: Response): Promise<void>;
  addAll(reqs: string[]): Promise<void>;
};
type CachesLike = {
  open(name: string): Promise<CacheLike>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
};
export type ShellEnv = {
  caches: CachesLike;
  fetch: (req: Request) => Promise<Response>;
  /** The worker's own origin (`self.location.origin`). */
  origin: string;
  buildId: string;
  /** This build's hashed `/assets/*` files. */
  assets: string[];
  timeoutMs?: number;
};

/** Paths the worker never answers (section 7.6c), besides everything that is not a same-origin GET. */
const PASS_PREFIXES = ['/api/', '/signal', '/download', '/.well-known/', '/replayer.html', '/room', '/join', '/invite', '/reset', '/c/', '/sso'];

export type Route = 'asset' | 'navigation' | 'pass';

/** Section 7.6c: what the worker does with a request. */
export function routeOf(req: Pick<Request, 'method' | 'url' | 'mode'>, origin: string): Route {
  if (req.method !== 'GET') return 'pass';
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return 'pass';
  }
  if (url.origin !== origin) return 'pass';
  const p = url.pathname;
  if (p === '/c' || p === '/api' || PASS_PREFIXES.some((x) => p.startsWith(x))) return 'pass';
  if (p.startsWith('/assets/')) return 'asset';
  if (req.mode === 'navigate' && (p === '/app' || p.startsWith('/app/'))) return 'navigation';
  return 'pass';
}

/** Section 7.6d: only a plain 200 without `no-store` may enter the cache. */
export function cacheable(res: Response): boolean {
  if (res.status !== 200 || res.type === 'opaque' || res.type === 'opaqueredirect') return false;
  return !/(^|[,\s])no-store([,\s]|$)/i.test(res.headers.get('Cache-Control') ?? '');
}

export function createShellWorker(env: ShellEnv) {
  const cacheName = `${SHELL_PREFIX}${env.buildId}`;
  const timeoutMs = env.timeoutMs ?? NAV_TIMEOUT_MS;

  async function install(): Promise<void> {
    const cache = await env.caches.open(cacheName);
    const files = [...SHELL_FILES, ...env.assets.filter((a) => a.startsWith('/assets/'))];
    // One by one, so a non-200 (or no-store) answer is never stored.
    await Promise.all(
      files.map(async (f) => {
        const res = await env.fetch(new Request(new URL(f, env.origin).toString(), { cache: 'reload' }));
        if (cacheable(res)) await cache.put(f, res);
      }),
    );
  }

  async function activate(): Promise<void> {
    for (const k of await env.caches.keys()) if (k.startsWith(SHELL_PREFIX) && k !== cacheName) await env.caches.delete(k);
  }

  async function asset(req: Request): Promise<Response> {
    const cache = await env.caches.open(cacheName);
    const hit = await cache.match(new URL(req.url).pathname);
    if (hit) return hit;
    const res = await env.fetch(req);
    if (cacheable(res)) await cache.put(new URL(req.url).pathname, res.clone());
    return res;
  }

  async function navigation(req: Request): Promise<Response> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      const res = await Promise.race([env.fetch(req).catch(() => null), timeout]);
      if (res) return res;
    } finally {
      clearTimeout(timer);
    }
    const cache = await env.caches.open(cacheName);
    const shell = await cache.match('/index.html');
    return shell ?? new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  /** Returns the response to answer with, or null to let the request pass through untouched. */
  function handle(req: Request): Promise<Response> | null {
    const route = routeOf(req, env.origin);
    if (route === 'asset') return asset(req);
    if (route === 'navigation') return navigation(req);
    return null;
  }

  return { cacheName, install, activate, handle };
}

// ---------- the worker itself ----------

declare const IA_SW_BUILD: string | undefined;
declare const IA_SW_ASSETS: string[] | undefined;

type SwScope = {
  location: { origin: string };
  caches: CachesLike;
  fetch: (req: Request) => Promise<Response>;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: string, fn: (e: Event & { waitUntil(p: Promise<unknown>): void; respondWith(r: Promise<Response>): void; request: Request }) => void): void;
};

const scope = globalThis as unknown as Partial<SwScope> & { registration?: unknown };
if (typeof IA_SW_BUILD === 'string' && scope.registration && scope.addEventListener && scope.caches && scope.location) {
  const sw = scope as SwScope;
  const worker = createShellWorker({
    caches: sw.caches,
    fetch: (r) => sw.fetch(r),
    origin: sw.location.origin,
    buildId: IA_SW_BUILD,
    assets: typeof IA_SW_ASSETS === 'undefined' ? [] : IA_SW_ASSETS,
  });
  sw.addEventListener('install', (e) => e.waitUntil(worker.install().then(() => sw.skipWaiting())));
  sw.addEventListener('activate', (e) => e.waitUntil(worker.activate().then(() => sw.clients.claim())));
  sw.addEventListener('fetch', (e) => {
    const r = worker.handle(e.request);
    if (r) e.respondWith(r);
  });
}
