/**
 * Cross-origin stylesheet fetch for the capture script (section 4.1): the extension origin has `<all_urls>`, so
 * the fetch is not CORS-bound; no credentials, 5 s timeout, once per URL per tab, 512 KiB per sheet and 4 MiB per
 * tab, `@import` stripped and `url()` neutralised by `sanitiseCssText` (section 12.3).
 */
import { LIMITS, isMirrorableUrl, sanitiseCssText } from '@indiansassist/shared';

export class CssFetcher {
  private perTab = new Map<number, { urls: Set<string>; bytes: number }>();

  constructor(private readonly fetchImpl: typeof fetch = (u, i) => fetch(u, i)) {}

  async fetchFor(tabId: number, url: string): Promise<string | null> {
    if (!isMirrorableUrl(url)) return null;
    let st = this.perTab.get(tabId);
    if (!st) {
      st = { urls: new Set(), bytes: 0 };
      this.perTab.set(tabId, st);
    }
    if (st.urls.has(url)) return null;
    st.urls.add(url);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try {
      const res = await this.fetchImpl(url, { credentials: 'omit', signal: ctl.signal, referrerPolicy: 'no-referrer' });
      if (!res.ok) return null;
      const text = await res.text();
      const bytes = new TextEncoder().encode(text).length;
      if (bytes > LIMITS.mirrorCssSheetMaxBytes || st.bytes + bytes > LIMITS.mirrorCssTabMaxBytes) return null;
      st.bytes += bytes;
      return sanitiseCssText(text.replace(/@import[^;]*;?/gi, ''));
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  forget(tabId: number): void {
    this.perTab.delete(tabId);
  }
}
