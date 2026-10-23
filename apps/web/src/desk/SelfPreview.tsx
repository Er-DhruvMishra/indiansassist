/**
 * Desk annotation preview (contracts section 8.2 / X2): a local preview of the Desk's own captured stream
 * with the technician's annotations drawn frame-relative on top. Floating in-page panel everywhere; in
 * Chromium it can pop out into a `documentPictureInPicture` window (always on top).
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnnotationCanvas } from '../components/AnnotationCanvas';
import { Button } from '../components/ui';
import type { AnnotState } from '../lib/annotation';

type PipApi = { requestWindow: (o: { width: number; height: number }) => Promise<Window> };

function pipApi(): PipApi | null {
  const api = (globalThis as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture;
  return api && typeof api.requestWindow === 'function' ? api : null;
}

function copyStyles(target: Window): void {
  for (const sheet of [...document.styleSheets]) {
    try {
      const css = [...sheet.cssRules].map((r) => r.cssText).join('\n');
      const style = target.document.createElement('style');
      style.textContent = css;
      target.document.head.appendChild(style);
    } catch {
      if (sheet.href) {
        const link = target.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        target.document.head.appendChild(link);
      }
    }
  }
}

function PreviewBody({ stream, annot }: { stream: MediaStream; annot: AnnotState }) {
  const video = useRef<HTMLVideoElement>(null);
  const [frame, setFrame] = useState({ w: 16, h: 9 });
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.srcObject = stream;
    void v.play?.()?.catch(() => undefined);
    const onSize = () => v.videoWidth && setFrame({ w: v.videoWidth, h: v.videoHeight });
    v.addEventListener('loadedmetadata', onSize);
    v.addEventListener('resize', onSize);
    return () => {
      v.removeEventListener('loadedmetadata', onSize);
      v.removeEventListener('resize', onSize);
    };
  }, [stream]);
  return (
    <div className="relative h-full w-full bg-slate-950">
      <video ref={video} muted playsInline autoPlay className="h-full w-full object-contain" aria-label="Preview of what you are sharing" />
      <AnnotationCanvas state={annot} frameW={frame.w} frameH={frame.h} fit="contain" label="Technician annotations on your shared screen" />
    </div>
  );
}

export function SelfPreview({ stream, annot, open, onClose }: { stream: MediaStream | null; annot: AnnotState; open: boolean; onClose: () => void }) {
  const [pipWin, setPipWin] = useState<Window | null>(null);
  const [large, setLarge] = useState(false);

  useEffect(() => () => pipWin?.close(), [pipWin]);

  if (!stream) return null;

  const popOut = async () => {
    const api = pipApi();
    if (!api) return;
    try {
      const win = await api.requestWindow({ width: 480, height: 300 });
      copyStyles(win);
      win.document.body.className = 'm-0 bg-slate-950';
      win.addEventListener('pagehide', () => setPipWin(null));
      setPipWin(win);
    } catch {
      /* the user dismissed or the browser refused */
    }
  };

  if (pipWin) {
    return (
      <>
        {createPortal(<PreviewBody stream={stream} annot={annot} />, pipWin.document.body)}
        <div className="fixed bottom-4 right-4 z-30 rounded-md bg-white p-2 text-sm shadow dark:bg-slate-900">
          Preview is in a separate window.{' '}
          <Button size="sm" variant="secondary" onClick={() => pipWin.close()}>
            Bring back
          </Button>
        </div>
      </>
    );
  }

  if (!open) return null;
  return (
    <aside
      aria-label="Annotation preview"
      className={`fixed bottom-4 right-4 z-30 flex flex-col overflow-hidden rounded-lg border border-slate-300 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900 ${large ? 'h-96 w-[40rem] max-w-[calc(100vw-2rem)]' : 'h-56 w-96 max-w-[calc(100vw-2rem)]'}`}
    >
      <div className="flex items-center justify-between gap-1 px-2 py-1 text-xs">
        <span className="font-medium">What your technician sees, with their annotations</span>
        <span className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setLarge((l) => !l)}>
            {large ? 'Smaller' : 'Larger'}
          </Button>
          {pipApi() && (
            <Button size="sm" variant="ghost" onClick={() => void popOut()}>
              Pop out
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close preview">
            Close
          </Button>
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <PreviewBody stream={stream} annot={annot} />
      </div>
    </aside>
  );
}
