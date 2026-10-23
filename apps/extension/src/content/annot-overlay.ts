/**
 * Annotations in the mirrored tab (Y8, Phase A 8.2 shapes with `tabId`): drawn in a `data-ia-block` canvas over
 * the viewport (never captured, never interactive), coordinates normalised to the tab viewport, each shape fading
 * after its TTL; `clear` removes all.
 */
type Point = { x: number; y: number };
type Shape =
  | { shape: 'arrow' | 'rect' | 'highlight'; id: string; a: Point; b: Point; color: string; ttlMs: number }
  | { shape: 'pointer'; id: string; at: Point; color: string }
  | { shape: 'clear' };

export class AnnotOverlay {
  private canvas: HTMLCanvasElement | null = null;
  private shapes = new Map<string, { s: Shape; until: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly doc: Document) {}

  apply(s: Shape): void {
    if (s.shape === 'clear') this.shapes.clear();
    else this.shapes.set(s.id, { s, until: Date.now() + (s.shape === 'pointer' ? 3000 : s.ttlMs) });
    this.draw();
  }

  private ensure(): CanvasRenderingContext2D | null {
    if (!this.canvas) {
      const c = this.doc.createElement('canvas');
      c.setAttribute('data-ia-block', '');
      for (const [k, v] of [
        ['position', 'fixed'],
        ['inset', '0'],
        ['pointer-events', 'none'],
        ['z-index', '2147483646'],
      ])
        c.style.setProperty(k!, v!, 'important');
      this.doc.documentElement.appendChild(c);
      this.canvas = c;
      this.timer = setInterval(() => this.draw(), 250);
    }
    const win = this.doc.defaultView!;
    this.canvas.width = win.innerWidth;
    this.canvas.height = win.innerHeight;
    return this.canvas.getContext?.('2d') ?? null;
  }

  private draw(): void {
    const now = Date.now();
    for (const [id, v] of this.shapes) if (v.until <= now) this.shapes.delete(id);
    if (this.shapes.size === 0) return this.destroy();
    const ctx = this.ensure();
    if (!ctx || !this.canvas) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 3;
    for (const { s } of this.shapes.values()) {
      if (s.shape === 'clear') continue;
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      if (s.shape === 'pointer') {
        ctx.beginPath();
        ctx.arc(s.at.x * W, s.at.y * H, 10, 0, Math.PI * 2);
        ctx.stroke();
        continue;
      }
      const [ax, ay, bx, by] = [s.a.x * W, s.a.y * H, s.b.x * W, s.b.y * H];
      if (s.shape === 'rect') ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      else if (s.shape === 'highlight') {
        ctx.globalAlpha = 0.3;
        ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
        ctx.globalAlpha = 1;
      } else {
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        const ang = Math.atan2(by - ay, bx - ax);
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx - 14 * Math.cos(ang - 0.4), by - 14 * Math.sin(ang - 0.4));
        ctx.lineTo(bx - 14 * Math.cos(ang + 0.4), by - 14 * Math.sin(ang + 0.4));
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.canvas?.remove();
    this.canvas = null;
  }
}
