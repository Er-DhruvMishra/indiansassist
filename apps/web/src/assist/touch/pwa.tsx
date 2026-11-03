/**
 * Phase F sections 7.5 to 7.7: installability of the Assist console.
 * - The `<link rel="manifest">` is not in the static `index.html`; `PwaHead` (mounted by `main.tsx` inside the router)
 *   inserts it only while the route is under `/app` and removes it on leaving, so the phone camera page (`/c`), the
 *   Desk's `/join` and `/room` pages and the public pages are never installable as the console.
 * - The app-shell service worker (`/sw.js`) is registered only in production builds and only on `/app` routes, so a
 *   Desk's browser never registers it.
 * - The Install button: Android Chrome's `beforeinstallprompt` is captured as early as possible (it can fire before
 *   the account page mounts); iOS has no prompt, so the console shows "Add to Home Screen" guidance once.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLocation } from 'react-router';

export const MANIFEST_HREF = '/manifest.webmanifest';
export const SW_URL = '/sw.js';
const LINK_ID = 'ia-manifest';

/** True for `/app` and everything under it. */
export function isConsolePath(pathname: string): boolean {
  return pathname === '/app' || pathname.startsWith('/app/');
}

/** Inserts or removes the manifest link for `pathname` (idempotent). */
export function syncManifestLink(pathname: string, doc: Document = document): void {
  const existing = doc.getElementById(LINK_ID);
  if (isConsolePath(pathname)) {
    if (existing) return;
    const link = doc.createElement('link');
    link.id = LINK_ID;
    link.rel = 'manifest';
    link.href = MANIFEST_HREF;
    doc.head.appendChild(link);
  } else {
    existing?.remove();
  }
}

type SwContainer = Pick<ServiceWorkerContainer, 'register'>;

/** Section 7.6a: production only, `/app` only, scope `/`. Returns whether a registration was attempted. */
export function registerShellWorker(
  pathname: string,
  opts: { prod?: boolean; container?: SwContainer | undefined } = {},
): boolean {
  const prod = opts.prod ?? import.meta.env.PROD;
  const container = 'container' in opts ? opts.container : typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  if (!prod || !container || !isConsolePath(pathname)) return false;
  void container.register(SW_URL, { scope: '/' }).catch(() => undefined);
  return true;
}

/** Mounted once by `main.tsx` inside `BrowserRouter`. Renders nothing. */
export function PwaHead() {
  const { pathname } = useLocation();
  useEffect(() => {
    syncManifestLink(pathname);
    registerShellWorker(pathname);
  }, [pathname]);
  useEffect(() => () => syncManifestLink('/'), []);
  return null;
}

// ---------- install prompt (section 7.7) ----------

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice?: Promise<{ outcome: 'accepted' | 'dismissed' }> };

type InstallState = { available: boolean; installed: boolean };
let deferred: InstallPromptEvent | null = null;
let state: InstallState = { available: false, installed: false };
const listeners = new Set<() => void>();
const emit = (next: InstallState) => {
  state = next;
  for (const l of listeners) l();
};

/** Called once at start-up (`main.tsx`): keeps the browser's install prompt for the account page's Install button. */
export function captureInstallPrompt(win: Window = window): void {
  win.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    emit({ ...state, available: true });
  });
  win.addEventListener('appinstalled', () => {
    deferred = null;
    emit({ available: false, installed: true });
  });
}

export function useInstallPrompt(): InstallState & { install: () => Promise<'accepted' | 'dismissed' | 'unavailable'> } {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
  return {
    ...s,
    install: async () => {
      const e = deferred;
      if (!e) return 'unavailable';
      deferred = null;
      emit({ ...state, available: false });
      await e.prompt();
      const choice = await e.userChoice?.catch(() => undefined);
      return choice?.outcome ?? 'dismissed';
    },
  };
}

/** iPhone / iPad Safari (iPadOS reports a Mac with touch). */
export function isIos(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> = navigator): boolean {
  return /iPhone|iPad|iPod/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1);
}

/** The console runs as an installed app (`display-mode: standalone`, or iOS `navigator.standalone`). */
export function isStandalone(win: Window = window): boolean {
  const iosStandalone = (win.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || (typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches);
}

const IOS_HINT_KEY = 'ia.iosInstallHintShown';

/** Section 7.7: show the iOS "Add to Home Screen" guidance once, in a browser tab only. */
export function shouldShowIosHint(win: Window = window): boolean {
  if (!isIos(win.navigator) || isStandalone(win)) return false;
  try {
    return win.localStorage.getItem(IOS_HINT_KEY) !== '1';
  } catch {
    return false;
  }
}

export function markIosHintShown(win: Window = window): void {
  try {
    win.localStorage.setItem(IOS_HINT_KEY, '1');
  } catch {
    /* private mode: the hint may show again */
  }
}

// ---------- offline start (section 7.6c) ----------

/**
 * When the installed console starts offline, the worker serves the cached shell; this gate then shows "You are
 * offline" and makes no call until the browser is online again. It decides only at start: a connection lost later
 * never unmounts a running console (a live session survives a brief drop).
 */
export function OfflineGate({ children, win = window }: { children: ReactNode; win?: Window }) {
  const [offline, setOffline] = useState(() => isConsolePath(win.location.pathname) && win.navigator.onLine === false);
  useEffect(() => {
    if (!offline) return;
    const on = () => setOffline(false);
    win.addEventListener('online', on);
    return () => win.removeEventListener('online', on);
  }, [offline, win]);
  if (!offline) return <>{children}</>;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold">You are offline</h1>
      <p className="text-base">The console opens as soon as this device is back online.</p>
      <button type="button" className="min-h-11 rounded-md bg-teal-700 px-4 font-medium text-white" onClick={() => win.location.reload()}>
        Try again
      </button>
    </main>
  );
}
