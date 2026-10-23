/**
 * Extension-local constants (docs/specs/phase-b-contracts.md sections 2.2, 9.1, 9.2). `REGION_ORIGINS` is compiled
 * from `VITE_REGION_ORIGINS` at build time (scripts/env.mjs); it is the only list of origins the extension ever
 * talks to or accepts a join handshake from.
 */
declare const __IA_REGION_ORIGINS__: string[];
declare const __IA_API_OVERRIDES__: Record<string, string>;
declare const __IA_DEFAULT_API_ORIGIN__: string;
declare const __IA_VERSION__: string;
declare const __IA_DEV__: boolean;
declare const __IA_E2E__: boolean;

export const REGION_ORIGINS: readonly string[] = Object.freeze([...__IA_REGION_ORIGINS__]);
/** Dev builds only: web origin -> api origin when they differ (Vite :5173 vs api :4000). Empty in production. */
export const API_ORIGIN_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({ ...__IA_API_OVERRIDES__ });
export const DEFAULT_API_ORIGIN: string = __IA_DEFAULT_API_ORIGIN__;
export const EXTENSION_VERSION: string = __IA_VERSION__;
export const IS_DEV: boolean = __IA_DEV__;
export const IS_E2E: boolean = __IA_E2E__;

/** Exact origin compare (scheme, host, port): no wildcard, no host-only compare, no port tolerance. */
export function isRegionOrigin(origin: unknown): origin is string {
  return typeof origin === 'string' && REGION_ORIGINS.includes(origin);
}

/** Base URL for REST calls of a region origin (the origin itself outside dev builds). */
export function restBaseFor(origin: string): string {
  return API_ORIGIN_OVERRIDES[origin] ?? origin;
}

export const EXTENSION_PHASES = [
  'idle',
  'have_token',
  'connecting',
  'waiting',
  'held',
  'knocked',
  'consent_pending',
  'active',
  'ended',
] as const;
export type ExtensionPhase = (typeof EXTENSION_PHASES)[number];

/** Phases in which a session exists on this profile (a second join answers `busy`). */
export const LIVE_PHASES: readonly ExtensionPhase[] = ['have_token', 'connecting', 'waiting', 'held', 'knocked', 'consent_pending', 'active'];

export const CAPTURE_SCRIPT_ID = 'ia-capture';
export const KEEPALIVE_ALARM = 'ia.keepalive';
export const OFFSCREEN_PATH = 'offscreen.html';
export const MIRROR_PORT = 'ia.mirror';
export const OFFSCREEN_PORT = 'ia.offscreen';
export const UI_PORT = 'ia.ui';
/** A tab that sends no `cs.ready` within this time after injection is `unsupported` with `inject_failed`. */
export const INJECT_READY_TIMEOUT_MS = 3000;
/** Content script self-stop after its Port to the offscreen document is lost (section 9.2). */
export const PORT_LOSS_STOP_MS = 5000;
/** Relay fallback starts when the mirror / control channels are not open this long after consent.ok (4.6). */
export const RELAY_FALLBACK_AFTER_MS = 5000;

/** WS reconnect backoff (section 9.2): 1, 2, 4, 8 s ... capped at 30 s. */
export function signalBackoffMs(attempt: number): number {
  return Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
}
