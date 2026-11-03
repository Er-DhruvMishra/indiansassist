/**
 * Phase F sections 7.5, 7.6a, 15.6: the manifest (`start_url` inside `scope`, `id`, icons), the manifest link present on
 * `/app/*` and absent on `/c`, `/join`, `/room`, `/login`, and the worker registered only in production on `/app`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { act, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MANIFEST_HREF, PwaHead, isConsolePath, registerShellWorker, syncManifestLink } from '../src/assist/touch/pwa';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(web, 'public/manifest.webmanifest'), 'utf8')) as Record<string, unknown> & {
  icons: { src: string; sizes: string; type: string; purpose: string }[];
};
const link = () => document.head.querySelector('link[rel="manifest"]');

afterEach(() => syncManifestLink('/'));

describe('manifest.webmanifest (section 7.5)', () => {
  it('names the console and keeps start_url inside scope', () => {
    expect(manifest['name']).toBe('IndiansAssist');
    expect(manifest['short_name']).toBe('Assist');
    expect(manifest['id']).toBe('/app/');
    expect(manifest['start_url']).toBe('/app/');
    expect(manifest['scope']).toBe('/app/');
    expect(String(manifest['start_url']).startsWith(String(manifest['scope']))).toBe(true);
    expect(manifest['display']).toBe('standalone');
    expect(manifest['orientation']).toBe('any');
    expect(manifest['theme_color']).toMatch(/^#[0-9a-f]{6}$/);
    expect(manifest['background_color']).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('has 192 and 512 PNG icons (any maskable) that exist and are PNGs of that size', () => {
    const sizes = manifest.icons.map((i) => i.sizes).sort();
    expect(sizes).toEqual(['192x192', '512x512']);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      expect(icon.purpose).toBe('any maskable');
      const file = resolve(web, 'public', icon.src.replace(/^\//, ''));
      expect(existsSync(file)).toBe(true);
      const png = readFileSync(file);
      expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes);
    }
  });

  it('is not linked from the static index.html; index.html has the mobile meta tags', () => {
    const html = readFileSync(resolve(web, 'index.html'), 'utf8');
    expect(html).not.toMatch(/rel="manifest"/);
    expect(html).toMatch(/viewport-fit=cover/);
    expect(html).toMatch(/<meta name="theme-color"/);
    expect(html).toMatch(/<link rel="apple-touch-icon"/);
    expect(html).toMatch(/<meta name="apple-mobile-web-app-capable" content="yes"/);
  });
});

describe('the manifest link (section 7.5)', () => {
  it('is present on /app pages only', () => {
    for (const p of ['/app', '/app/', '/app/sessions/abc', '/app/account']) {
      syncManifestLink(p);
      expect(link()?.getAttribute('href')).toBe(MANIFEST_HREF);
    }
    for (const p of ['/c', '/c/ABCD1234EFGH', '/join', '/room/x', '/login', '/', '/reset', '/apple']) {
      syncManifestLink(p);
      expect(link()).toBeNull();
    }
    expect(isConsolePath('/application')).toBe(false);
  });

  it('PwaHead adds it on entering /app and removes it on leaving', async () => {
    let go: (to: string) => void = () => undefined;
    function Nav() {
      go = useNavigate();
      return null;
    }
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/login'] },
        createElement(PwaHead),
        createElement(Routes, null, createElement(Route, { path: '*', element: createElement(Nav) })),
      ),
    );
    expect(link()).toBeNull();
    await act(async () => go('/app/sessions'));
    expect(link()).not.toBeNull();
    await act(async () => go('/c/ABCD1234EFGH'));
    expect(link()).toBeNull();
    await act(async () => go('/app/'));
    expect(link()).not.toBeNull();
    await act(async () => go('/join'));
    expect(link()).toBeNull();
  });
});

describe('service worker registration (section 7.6a)', () => {
  it('registers /sw.js with scope / only in production and only on /app', () => {
    const register = vi.fn(() => Promise.resolve({} as ServiceWorkerRegistration));
    const container = { register } as unknown as Pick<ServiceWorkerContainer, 'register'>;
    expect(registerShellWorker('/app/sessions', { prod: false, container })).toBe(false);
    expect(registerShellWorker('/join', { prod: true, container })).toBe(false);
    expect(registerShellWorker('/c/ABCD', { prod: true, container })).toBe(false);
    expect(registerShellWorker('/room/x', { prod: true, container })).toBe(false);
    expect(register).not.toHaveBeenCalled();
    expect(registerShellWorker('/app', { prod: true, container })).toBe(true);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(registerShellWorker('/app', { prod: true, container: undefined })).toBe(false);
  });
});
