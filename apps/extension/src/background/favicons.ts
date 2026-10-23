/**
 * Favicon inlining (section 4.5): the worker fetches `tab.favIconUrl` itself (it has `<all_urls>`), without
 * credentials, 3 s timeout, at most 8 KiB, once per URL per session, and hands the Assist a `data:image/*` URL or
 * null. The console never fetches anything for a favicon.
 */
import { LIMITS } from '@indiansassist/shared';
import type { FetchLike } from '../shared/api';

const IMAGE_TYPE = /^image\/(png|x-icon|vnd\.microsoft\.icon|gif|jpeg|webp|avif|bmp)$/;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export class FaviconCache {
  private cache = new Map<string, string | null>();
  private inflight = new Map<string, Promise<string | null>>();

  constructor(private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i)) {}

  /** The cached value, or undefined when not fetched yet (call `load`). */
  peek(url: string | undefined): string | null | undefined {
    if (!url) return null;
    return this.cache.get(url);
  }

  async load(url: string | undefined): Promise<string | null> {
    if (!url || !/^https?:\/\//.test(url)) return url?.startsWith('data:image/') && url.length <= 11000 ? url : null;
    if (this.cache.has(url)) return this.cache.get(url)!;
    const running = this.inflight.get(url);
    if (running) return running;
    const p = this.fetchOne(url).then((v) => {
      this.cache.set(url, v);
      this.inflight.delete(url);
      return v;
    });
    this.inflight.set(url, p);
    return p;
  }

  private async fetchOne(url: string): Promise<string | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    try {
      const res = await this.fetchImpl(url, { credentials: 'omit', signal: ctl.signal, redirect: 'follow' });
      if (!res.ok) return null;
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!IMAGE_TYPE.test(type)) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > LIMITS.faviconMaxBytes) return null;
      return `data:${type};base64,${toBase64(buf)}`;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  clear(): void {
    this.cache.clear();
    this.inflight.clear();
  }
}
