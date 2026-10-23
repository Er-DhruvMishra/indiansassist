/**
 * Client-rendered QR code of a join URL (contracts section 12, no server call). Uses the qrcode
 * library's matrix and renders an SVG path, so it needs no canvas.
 */
import * as QRCodeLib from 'qrcode';
import { useMemo } from 'react';

type QrModules = { size: number; data: ArrayLike<number | boolean> };
type QrCreate = (text: string, opts?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' }) => { modules: QrModules };

function createFn(): QrCreate | null {
  const mod = QRCodeLib as unknown as { create?: QrCreate; default?: { create?: QrCreate } };
  return mod.create ?? mod.default?.create ?? null;
}

/** Builds the SVG path data for a QR matrix (1 unit per module, quiet zone of 4). */
export function qrPath(text: string): { size: number; d: string } | null {
  const create = createFn();
  if (!create) return null;
  try {
    const { modules } = create(text, { errorCorrectionLevel: 'M' });
    const n = modules.size;
    const parts: string[] = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (modules.data[y * n + x]) parts.push(`M${x + 4} ${y + 4}h1v1h-1z`);
      }
    }
    return { size: n + 8, d: parts.join('') };
  } catch {
    return null;
  }
}

export function QrCode({ text, label, size = 176 }: { text: string; label: string; size?: number }) {
  const qr = useMemo(() => qrPath(text), [text]);
  if (!qr) return <p className="text-sm text-slate-600 dark:text-slate-400">QR code unavailable.</p>;
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
      className="rounded bg-white"
    >
      <rect width={qr.size} height={qr.size} fill="#ffffff" />
      <path d={qr.d} fill="#000000" />
    </svg>
  );
}
