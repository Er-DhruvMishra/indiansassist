/**
 * Phase F section 7.4: which console layout the viewport gets.
 * - `phone`: narrower than 600 px in portrait;
 * - `phone_landscape`: a landscape viewport less than 600 px tall, or the installed app (`display-mode: standalone`)
 *   in landscape below 1024 px;
 * - `tablet`: 600 px up to 1024 px;
 * - `desktop`: 1024 px and wider (today's layout, unchanged).
 * `coarse` is `(pointer: coarse)`: a touch screen, where the keys bar and the touch toggles are offered even on the
 * desktop layout (a large tablet in landscape).
 */
import { useEffect, useState } from 'react';
import { isStandalone } from './pwa';

export type ConsoleLayoutKind = 'phone' | 'phone_landscape' | 'tablet' | 'desktop';
export type Viewport = { layout: ConsoleLayoutKind; width: number; height: number; coarse: boolean; standalone: boolean };

export const PHONE_MAX = 600;
export const TABLET_MAX = 1024;

export function layoutFor(width: number, height: number, standalone: boolean): ConsoleLayoutKind {
  const landscape = width > height;
  if (landscape && (height < PHONE_MAX || (standalone && width < TABLET_MAX))) return 'phone_landscape';
  if (width < PHONE_MAX) return 'phone';
  if (width < TABLET_MAX) return 'tablet';
  return 'desktop';
}

/**
 * The layout viewport (what CSS media queries see), not `innerWidth`: a mobile browser zooms out over content wider
 * than the screen, which grows `innerWidth` and would flip a phone into the desktop layout.
 */
function read(win: Window): Viewport {
  const root = win.document?.documentElement;
  const width = root?.clientWidth || win.innerWidth || TABLET_MAX;
  const height = root?.clientHeight || win.innerHeight || 768;
  const standalone = isStandalone(win);
  const coarse = typeof win.matchMedia === 'function' && win.matchMedia('(pointer: coarse)').matches;
  return { layout: layoutFor(width, height, standalone), width, height, coarse, standalone };
}

export function useViewport(win: Window = window): Viewport {
  const [vp, setVp] = useState(() => read(win));
  useEffect(() => {
    const update = () =>
      setVp((prev) => {
        const next = read(win);
        return next.layout === prev.layout && next.coarse === prev.coarse && next.width === prev.width && next.height === prev.height ? prev : next;
      });
    win.addEventListener('resize', update);
    win.addEventListener('orientationchange', update);
    return () => {
      win.removeEventListener('resize', update);
      win.removeEventListener('orientationchange', update);
    };
  }, [win]);
  return vp;
}
