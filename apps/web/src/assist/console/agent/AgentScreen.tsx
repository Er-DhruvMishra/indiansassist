/**
 * The P3 remote screen (section 3.6 M4, 5.2): the viewed monitor through the A watermark `RemoteView` with the input
 * overlay, or **All monitors** as a mosaic laid out from the monitors' virtual-desktop rects, each tile with its own
 * overlay (input mapped per monitor from the mosaic hit test).
 */
import { useCallback, useState, type RefObject } from 'react';
import type { DcAnnot, MonitorInfo } from '@indiansassist/shared';
import type { AnnotState, AnnotTool } from '../../../lib/annotation';
import { RemoteView, type RemoteTouch } from '../RemoteView';
import { InputOverlay, type OverlayActions } from './InputOverlay';
import { mosaicLayout } from './MonitorPicker';

type Watermark = { name: string; userId: string; sessionId: string };

/** The stream of a monitor: by SDP mid, else the only stream there is. */
export function streamOf(m: MonitorInfo | undefined, streams: Record<string, MediaStream>): MediaStream | null {
  const keys = Object.keys(streams);
  if (m?.mid && streams[m.mid]) return streams[m.mid]!;
  return keys.length === 1 ? streams[keys[0]!]! : null;
}

export function AgentScreen({
  monitors,
  viewed,
  streams,
  controlling,
  actions,
  annot,
  tool,
  color,
  watermark,
  onAnnot,
  onCanvas,
  onFirstFrame,
  fullscreenRef,
  toolbar,
  emptyText,
  touch,
  tall,
}: {
  /** Phase F section 7.2: the touch gestures of each monitor's view (absent: touch ignored as before). */
  touch?: (monitorId: number) => RemoteTouch;
  /** Phase F section 7.4: the view may use the whole screen height. */
  tall?: boolean;
  monitors: MonitorInfo[];
  viewed: number | 'all';
  streams: Record<string, MediaStream>;
  controlling: boolean;
  actions: OverlayActions;
  annot: AnnotState;
  tool: AnnotTool | null;
  color: string;
  watermark: Watermark;
  onAnnot: (m: DcAnnot) => void;
  onCanvas: (c: HTMLCanvasElement | null) => void;
  onFirstFrame: () => void;
  fullscreenRef: RefObject<HTMLDivElement>;
  toolbar: React.ReactNode;
  emptyText: string;
}) {
  const [noCanvas] = useState(() => () => undefined);
  const nop = useCallback(() => undefined, []);
  if (viewed === 'all' && monitors.length > 1) {
    const layout = mosaicLayout(monitors);
    return (
      <div ref={fullscreenRef} className="flex flex-col gap-2">
        {toolbar}
        <div className="relative w-full rounded-md bg-slate-950" style={{ aspectRatio: '16 / 7' }} aria-label="All monitors">
          {layout.map((t) => {
            const m = monitors.find((x) => x.id === t.id)!;
            const s = streamOf(m, streams);
            return (
              <div key={t.id} className="absolute overflow-hidden border border-slate-700" style={{ left: `${t.left}%`, top: `${t.top}%`, width: `${t.width}%`, height: `${t.height}%` }}>
                <RemoteView
                  stream={s}
                  annot={annot}
                  tool={null}
                  color={color}
                  fit
                  watermark={watermark}
                  description={`Monitor ${m.name || m.id}`}
                  onAnnot={nop}
                  onCanvas={noCanvas}
                  emptyText={`${m.name || `Monitor ${m.id}`}: paused`}
                  overlay={<InputOverlay monitorId={m.id} enabled={controlling} actions={actions} label={`Control monitor ${m.name || m.id}`} />}
                  touch={touch?.(m.id)}
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  const id = viewed === 'all' ? (monitors[0]?.id ?? 1) : viewed;
  const m = monitors.find((x) => x.id === id);
  const stream = streamOf(m, streams);
  return (
    <RemoteView
      stream={stream}
      annot={annot}
      tool={controlling ? null : tool}
      color={color}
      fit
      watermark={watermark}
      description={stream ? `Remote monitor ${m?.name || id}${m ? `, ${m.width} by ${m.height}` : ''}` : 'Remote screen, not connected'}
      onAnnot={onAnnot}
      onCanvas={onCanvas}
      onFirstFrame={onFirstFrame}
      fullscreenRef={fullscreenRef}
      toolbar={toolbar}
      emptyText={emptyText}
      overlay={<InputOverlay monitorId={id} enabled={controlling && stream !== null} actions={actions} label={`Control monitor ${m?.name || id}`} />}
      touch={touch?.(id)}
      tall={tall}
    />
  );
}
