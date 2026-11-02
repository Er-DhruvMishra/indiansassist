/**
 * Join page helpers for a `p3_portable` token (docs/specs/phase-c-contracts.md sections 2.5 L3, 2.6, 2.7): platform
 * detection from low-entropy signals only (no high-entropy UA hints), the deep link, the 1500 ms "did the app open"
 * guard, the `ia.agent.seen` flag set only by `/join?kept=1`, and the programmatic `<a download>` click. Phase E
 * section 7.6 adds Linux: its detection and the shell line that extracts and starts the per-download archive.
 */
import { AGENT_LINUX_FILENAME_RE } from '@indiansassist/shared';

export type DeskPlatform = 'windows' | 'android' | 'ios' | 'linux';

export const AGENT_SEEN_KEY = 'ia.agent.seen';
export const DEEP_LINK_WAIT_MS = 1500;

type NavLike = { userAgent: string; userAgentData?: { platform?: string } };

export function detectPlatform(nav: NavLike): DeskPlatform {
  if (nav.userAgentData?.platform === 'Android' || /Android/.test(nav.userAgent)) return 'android';
  if (/iPhone|iPad|iPod/.test(nav.userAgent)) return 'ios';
  // Phase E section 7.6: Linux (every Android UA also says Linux, so Android is ruled out first).
  if (nav.userAgentData?.platform === 'Linux' || (/Linux/.test(nav.userAgent) && !/Android/.test(nav.userAgent))) return 'linux';
  return 'windows';
}

/**
 * Phase E section 7.6: `cd ~/Downloads && tar -xzf <archive> && ./<inner>` for a served Linux archive name, or null
 * when the name is not the `IndiansAssist-<region>-<dddd>-<dddd>-<dddd>.tar.gz` grammar (nothing else reaches a shell
 * line the user is asked to paste).
 */
export function linuxRunCommand(archiveName: string): string | null {
  const inner = archiveName.endsWith('.tar.gz') ? archiveName.slice(0, -'.tar.gz'.length) : '';
  if (!AGENT_LINUX_FILENAME_RE.test(inner)) return null;
  return `cd ~/Downloads && tar -xzf ${archiveName} && ./${inner}`;
}

/** `indiansassist://join?t=<compact>` or `?c=<12 digits>` (section 2.5 L2). */
export function deepLinkFor(code: string): string {
  return /^\d{12}$/.test(code) ? `indiansassist://join?c=${code}` : `indiansassist://join?t=${encodeURIComponent(code)}`;
}

/** The join link a second device (or the Android App Link) opens. */
export function joinLinkFor(origin: string, code: string): string {
  return `${origin}/join#t=${encodeURIComponent(code)}`;
}

export type DeepLinkEnv = {
  assign: (url: string) => void;
  /** Subscribes to "the page lost visibility or focus"; returns the unsubscribe. */
  onLeave: (cb: () => void) => () => void;
  setTimeout: (cb: () => void, ms: number) => unknown;
};

export function browserDeepLinkEnv(): DeepLinkEnv {
  return {
    assign: (url) => window.location.assign(url),
    onLeave: (cb) => {
      const vis = () => {
        if (document.visibilityState === 'hidden') cb();
      };
      document.addEventListener('visibilitychange', vis);
      window.addEventListener('blur', cb);
      return () => {
        document.removeEventListener('visibilitychange', vis);
        window.removeEventListener('blur', cb);
      };
    },
    setTimeout: (cb, ms) => window.setTimeout(cb, ms),
  };
}

/**
 * Tries the deep link: resolves true when the page was hidden or blurred within 1500 ms (the agent opened), false
 * otherwise (no handler: the caller shows the download panel). The browser's "Open IndiansAssist?" dialog is the
 * only confirmation.
 */
export function tryDeepLink(url: string, env: DeepLinkEnv): Promise<boolean> {
  return new Promise((resolve) => {
    let left = false;
    const off = env.onLeave(() => {
      left = true;
    });
    try {
      env.assign(url);
    } catch {
      /* no handler registered */
    }
    env.setTimeout(() => {
      off();
      resolve(left);
    }, DEEP_LINK_WAIT_MS);
  });
}

/** Starts the browser download of a grant URL with the served filename (no navigation away from the page). */
export function clickDownload(url: string, filename: string, doc: Document = document): void {
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  doc.body.appendChild(a);
  a.click();
  a.remove();
}

/** Grouped 12-digit code for display: `4821 9365 7715`. */
export function groupCode(code: string): string {
  return /^\d{12}$/.test(code) ? `${code.slice(0, 4)} ${code.slice(4, 8)} ${code.slice(8)}` : code;
}
