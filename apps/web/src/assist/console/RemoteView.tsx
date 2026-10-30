/**
 * Remote view (contracts sections 9 and 12): the remote video is drawn through a canvas carrying the
 * technician watermark (the same canvas is recorded), with the annotation overlay on top, a fit / actual
 * size toggle and fullscreen.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { DcAnnot } from '@indiansassist/shared';
import { AnnotationCanvas } from '../../components/AnnotationCanvas';
import type { AnnotState, AnnotTool } from '../../lib/annotation';
import { drawWatermark, watermarkText } from '../../lib/recorder';
import { safeContext } from '../../components/AnnotationCanvas';

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
};

export function RemoteView({ stream, annot, tool, color, fit, watermark, description, onAnnot, onCanvas, onFirstFrame, onFrameSize, toolbar, fullscreenRef, emptyText, overlay }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frame, setFrame] = useState({ w: 0, h: 0 });
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
      <div className={`relative rounded-md bg-slate-950 ${fit ? 'flex max-h-[70vh] items-center justify-center overflow-hidden' : 'max-h-[75vh] overflow-auto'}`}>
        <video ref={videoRef} muted playsInline autoPlay className="hidden" aria-hidden="true" />
        {!stream && <p className="flex h-72 items-center justify-center p-6 text-center text-sm text-slate-200">{emptyText}</p>}
        <div className={`relative ${stream ? '' : 'hidden'} ${fit ? 'max-h-[70vh] max-w-full' : 'inline-block'}`}>
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={description}
            className={fit ? 'block max-h-[70vh] max-w-full' : 'block'}
            style={fit ? { width: 'auto', height: 'auto' } : undefined}
          />
          <AnnotationCanvas state={annot} frameW={frame.w} frameH={frame.h} fit="fill" tool={tool} color={color} onAnnot={onAnnot} />
          {overlay}
        </div>
      </div>
    </div>
  );
}
