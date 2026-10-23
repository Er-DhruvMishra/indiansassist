/** WCAG contrast helpers (A3): branding accent colours fall back to the default when they fail. */
export const DEFAULT_ACCENT = '#0f766e';

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** An accent usable behind white text (>= 4.5:1), else the default. */
export function safeAccent(hex: string | null | undefined): string {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return DEFAULT_ACCENT;
  return contrastRatio(hex, '#ffffff') >= 4.5 ? hex : DEFAULT_ACCENT;
}
