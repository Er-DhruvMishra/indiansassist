/**
 * Remote view (contracts sections 9 and 12): the remote video is drawn through a canvas carrying the
 * technician watermark (the same canvas is recorded), with the annotation overlay on top, a fit / actual
 * size toggle and fullscreen.
 *
 * Phase F section 7.2: with `touch`, touch pointers on the view are gestures (`useTouchSurface`): pinch zooms the view
 * locally (1x-4x) and sends nothing; ops are normalised to the video rectangle after the zoom; in P1 (and a P3 console
 * in view mode) a tap is a laser ping and a drag draws with the selected tool. Mouse and pen are unchanged.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { DcAnnot, GestureDesk } from '@indiansassist/shared';
import { AnnotationCanvas } from '../../components/AnnotationCanvas';
import { makeBoxAnnot, makePointer, type AnnotState, type AnnotTool, type LiveShape } from '../../lib/annotation';
import { uuid } from '../../lib/ids';
import { drawWatermark, watermarkText } from '../../lib/recorder';
import { safeContext } from '../../components/AnnotationCanvas';
import { TrackpadCursor, ZoomChip, useTouchSurface, type AnnotateAction, type TouchOp } from '../touch/TouchSurface';

/** Phase F section 7.2: the touch behaviour of a view. */
export type RemoteTouch = {
  desk: GestureDesk;
  trackpad: boolean;
  scrollWhileZoomed: boolean;
  onOp?: (op: TouchOp) => void;
  onKeyboardToggle?: () => void;
  /** Taps and drags annotate (P1, or a P3 console in view mode). */
  annotate?: boolean;
};

type Props = {
  stream: MediaStream | null;
  annot: AnnotState;
  tool: AnnotTool | null;
  color: string;
  fit: boolean;
  watermark: { name: string; userId: string; sessionId: string };
  description: string;
  onAnnot: (m: DcAnnot) => void;
  onCanvas: (c: HTMLCanvasElement | null) => void;
  onFirstFrame?: () => void;
  onFrameSize?: (w: number, h: number) => void;
  toolbar?: ReactNode;
  fullscreenRef?: RefObject<HTMLDivElement>;
  emptyText: string;
  /** Phase C section 5.2: the transparent input overlay of a P3 console, stacked over the video. */
  overlay?: ReactNode;
  /** Phase F section 7.2: touch gestures (absent: the view ignores touch as before). */
  touch?: RemoteTouch;
  /** Phase F section 7.4: the view may use the whole screen height (phone landscape). */
  tall?: boolean;
};

export function RemoteView({ stream, annot, tool, color, fit, watermark, description, onAnnot, onCanvas, onFirstFrame, onFrameSize, toolbar, fullscreenRef, emptyText, overlay, touch, tall = false }: Props) {
  const maxH = tall ? 'max-h-[100dvh]' : 'max-h-[70vh]';
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const [draft, setDraft] = useState<LiveShape | null>(null);
  const laserId = useRef(uuid());
  const laserAt = useRef(0);
  const annotRef = useRef({ tool, color, onAnnot, annotate: touch?.annotate === true });
  annotRef.current = { tool, color, onAnnot, annotate: touch?.annotate === true };
  const onAnnotate = useCallback((a: AnnotateAction) => {
    const r = annotRef.current;
    if (!r.annotate) return;
    const pt = { x: a.x, y: a.y };
    const laser = (force: boolean) => {
      const now = Date.now();
      if (!force && now - laserAt.current < 50) return;
      laserAt.current = now;
      r.onAnnot(makePointer(pt, r.color, laserId.current, now));
    };
    if (a.action === 'laser') return laser(true);
    // A drag with a box tool draws that shape; with the pointer tool (or none) it moves the laser.
    const box = r.tool && r.tool !== 'pointer' ? r.tool : null;
    if (!box) return laser(a.phase !== 'move');
    if (a.phase === 'start') return setDraft({ id: 'touch-draft', shape: box, a: pt, b: pt, color: r.color, expiresAt: Number.POSITIVE_INFINITY });
    setDraft((d) => {
      if (!d) return d;
      const next = { ...d, b: pt };
      if (a.phase !== 'end') return next;
      if (Math.hypot(next.b.x - next.a.x, next.b.y - next.a.y) >= 0.005) queueMicrotask(() => r.onAnnot(makeBoxAnnot(next.shape, next.a, next.b, next.color)));
      return null;
    });
  }, []);
  const surface = useTouchSurface({
    outer: outerRef,
    inner: innerRef,
    enabled: touch !== undefined && stream !== null,
    desk: touch?.desk ?? { kind: 'none', control: false },
    trackpad: touch?.trackpad ?? false,
    scrollWhileZoomed: touch?.scrollWhileZoomed ?? false,
    onOp: touch?.onOp,
    onKeyboardToggle: touch?.onKeyboardToggle,
    onAnnotate,
  });
  const shownAnnot = draft ? { ...annot, shapes: [...annot.shapes, draft] } : annot;
  const wm = useRef(watermark);
  wm.current = watermark;
  const firstFrame = useRef(onFirstFrame);
  firstFrame.current = onFirstFrame;
  const frameSize = useRef(onFrameSize);
  frameSize.current = onFrameSize;

  useEffect(() => {
    onCanvas(canvasRef.current);
    return () => onCanvas(null);
  }, [onCanvas]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) void v.play?.()?.catch(() => undefined);
  }, [stream]);

  useEffect(() => {
    if (!stream) return;
    let raf = 0;
    let text = '';
    let textAt = 0;
    let reported = false;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const v = videoRef.current;
      const c = canvasRef.current;
      if (!v || !c || v.readyState < 2 || v.videoWidth === 0) return;
      if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        setFrame({ w: v.videoWidth, h: v.videoHeight });
        frameSize.current?.(v.videoWidth, v.videoHeight);
      }
      const ctx = safeContext(c);
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, c.width, c.height);
      const now = Date.now();
      if (now - textAt >= 1000) {
        text = watermarkText(wm.current.name, wm.current.userId, wm.current.sessionId, new Date(now));
        textAt = now;
      }
      drawWatermark(ctx, c.width, c.height, text);
      if (!reported) {
        reported = true;
        firstFrame.current?.();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [stream]);

  return (
    <div ref={fullscreenRef} className="flex flex-col gap-2 bg-white dark:bg-slate-900">
      {toolbar}
      <div ref={outerRef} style={surface.outerStyle} className={`relative rounded-md bg-slate-950 ${fit ? `flex ${maxH} items-center justify-center overflow-hidden` : 'max-h-[75vh] overflow-auto'}`}>
        <video ref={videoRef} muted playsInline autoPlay className="hidden" aria-hidden="true" />
        {!stream && <p className="flex h-72 items-center justify-center p-6 text-center text-sm text-slate-200">{emptyText}</p>}
        <div ref={innerRef} style={surface.innerStyle} className={`relative ${stream ? '' : 'hidden'} ${fit ? `${maxH} max-w-full` : 'inline-block'}`}>
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={description}
            className={fit ? `block ${maxH} max-w-full` : 'block'}
            style={fit ? { width: 'auto', height: 'auto' } : undefined}
          />
          <AnnotationCanvas state={shownAnnot} frameW={frame.w} frameH={frame.h} fit="fill" tool={tool} color={color} onAnnot={onAnnot} />
          {overlay}
          <TrackpadCursor at={surface.cursor} />
        </div>
        {touch && <ZoomChip zoom={surface.zoom} onReset={surface.resetZoom} />}
      </div>
    </div>
  );
}
