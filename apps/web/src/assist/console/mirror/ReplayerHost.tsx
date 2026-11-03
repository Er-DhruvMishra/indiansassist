/**
 * Replayer host (Phase B 10.1, 10.2): the sandboxed replayer frame (`REPLAYER_SANDBOX`, hash-only CSP), the
 * technician watermark (CSS overlay, `pointer-events: none`),
 * the placeholders ("Paused by the user", "Protected page", "Waiting for snapshot", "Too large to mirror",
 * "Reconnecting") and the embedded-frame hint. The frame stays mounted under a placeholder so its replayers survive.
 * Phase F section 7.1: touch on the mirror (tap, long press, two-finger scroll, local pinch zoom) is recognised inside
 * the frame (`src/replayer/main.ts`), which posts the same `rp.*` captures a mouse would.
 */
import { useCallback, type RefObject } from 'react';
import { useNow } from '../../../hooks/useAsync';
import { watermarkText } from '../../../lib/recorder';

export const REPLAYER_SRC = '/replayer.html';
/**
 * Contract deviation (Phase B 10.2 asks for `allow-scripts` alone): with an opaque origin rrweb cannot reach its own
 * inner replay iframe (inherited sandbox flags give it a second opaque origin; verified in Chromium 156), so the
 * frame keeps the console's origin. Mirrored content still never runs: events are sanitised on both sides, rrweb's
 * inner iframe has no `allow-scripts`, and the frame's CSP allows only its own hashed script.
 */
export const REPLAYER_SANDBOX = 'allow-scripts allow-same-origin';

export function ReplayerHost({
  title,
  placeholder,
  stale,
  frameHint,
  armed,
  watermark,
  onFrame,
  fullscreenRef,
  tall = false,
}: {
  title: string;
  placeholder: string | null;
  stale: boolean;
  frameHint: boolean;
  armed: 'off' | 'input' | 'reveal';
  watermark: { name: string; userId: string; sessionId: string };
  onFrame: (frame: HTMLIFrameElement | null) => void;
  fullscreenRef?: RefObject<HTMLDivElement>;
  /** Phase F section 7.4: the mirror may use the whole screen height (phone landscape). */
  tall?: boolean;
}) {
  const now = useNow(1000);
  const ref = useCallback((el: HTMLIFrameElement | null) => onFrame(el), [onFrame]);
  const text = watermarkText(watermark.name, watermark.userId, watermark.sessionId, new Date(now));
  return (
    <div ref={fullscreenRef} className={`relative ${tall ? 'h-[100dvh]' : 'h-[70vh]'} min-h-80 overflow-hidden rounded-md bg-slate-950`}>
      <iframe
        ref={ref}
        src={REPLAYER_SRC}
        sandbox={REPLAYER_SANDBOX}
        referrerPolicy="no-referrer"
        title={`Mirrored tab: ${title}`}
        data-testid="replayer-frame"
        className="absolute inset-0 h-full w-full border-0 bg-slate-50"
      />
      <div aria-hidden="true" data-testid="watermark" className="pointer-events-none absolute inset-0 flex select-none flex-wrap content-start gap-x-24 gap-y-16 overflow-hidden p-6 text-xs font-semibold text-slate-900/15 dark:text-slate-100/15" style={{ transform: 'rotate(-18deg) scale(1.3)' }}>
        {Array.from({ length: 24 }, (_, i) => (
          <span key={i}>{text}</span>
        ))}
      </div>
      {armed === 'reveal' && <div className="pointer-events-none absolute inset-x-0 top-0 bg-teal-700 px-3 py-1 text-center text-sm text-white">Click a hidden field to ask the user to reveal it.</div>}
      {placeholder && (
        <div role="status" className="absolute inset-0 flex items-center justify-center bg-slate-900/85 p-6 text-center text-base font-medium text-slate-100">
          {placeholder}
        </div>
      )}
      {stale && (
        <div role="status" className="pointer-events-none absolute right-2 top-2 rounded bg-amber-200 px-2 py-1 text-xs font-semibold text-amber-950">
          Reconnecting
        </div>
      )}
      {frameHint && (
        <div role="alert" className="absolute inset-x-0 bottom-0 bg-amber-100 px-3 py-2 text-sm text-amber-950">
          This area is an embedded frame and cannot be controlled.
        </div>
      )}
    </div>
  );
}
