import { describe, expect, it } from 'vitest';
import { DEV_API_URL, readRuntimeConfig, resolveApiUrl, resolveRegionOrigins } from '../src/lib/runtimeConfig';

const base = { buildValue: undefined, runtimeValue: '', prod: true, pageOrigin: 'https://page.example' };

describe('readRuntimeConfig', () => {
  it('reads and trims the two values', () => {
    expect(
      readRuntimeConfig({ __IA_RUNTIME_CONFIG__: { apiUrl: ' https://a.example ', regionOrigins: 'in-mum=https://a.example' } }),
    ).toEqual({ apiUrl: 'https://a.example', regionOrigins: 'in-mum=https://a.example' });
  });

  it.each([undefined, null, 'x', 7, []])('reads %j as empty', (raw) => {
    expect(readRuntimeConfig({ __IA_RUNTIME_CONFIG__: raw })).toEqual({ apiUrl: '', regionOrigins: '' });
  });

  it('ignores non-string members', () => {
    expect(readRuntimeConfig({ __IA_RUNTIME_CONFIG__: { apiUrl: 42, regionOrigins: {} } })).toEqual({
      apiUrl: '',
      regionOrigins: '',
    });
  });
});

describe('resolveApiUrl', () => {
  it('prefers a build-time value over everything, and strips its trailing slash', () => {
    expect(resolveApiUrl({ ...base, buildValue: 'https://built.example/', runtimeValue: 'https://run.example' })).toBe(
      'https://built.example',
    );
  });

  it('keeps a build-time value that is not https (a local stack), as before', () => {
    expect(resolveApiUrl({ ...base, buildValue: 'http://localhost:4140' })).toBe('http://localhost:4140');
  });

  it('uses the runtime origin when nothing is compiled in', () => {
    expect(resolveApiUrl({ ...base, runtimeValue: 'https://run.example/' })).toBe('https://run.example');
  });

  it('is same-origin in a production bundle with neither', () => {
    expect(resolveApiUrl(base)).toBe('https://page.example');
  });

  it('keeps the dev fallback outside production', () => {
    expect(resolveApiUrl({ ...base, prod: false })).toBe(DEV_API_URL);
    expect(DEV_API_URL).toBe('http://localhost:4000');
  });

  it('falls back to the dev api where there is no page and no production build', () => {
    expect(resolveApiUrl({ ...base, prod: false, pageOrigin: '' })).toBe(DEV_API_URL);
  });

  it.each([
    'http://run.example',
    'javascript:alert(1)',
    'https://user:pw@run.example',
    'https://run.example/api',
    'https://run.example/?x=1',
    'not a url',
  ])('rejects the unusable runtime value %s in production and stays same-origin', (runtimeValue) => {
    expect(resolveApiUrl({ ...base, runtimeValue })).toBe('https://page.example');
  });

  it('accepts an http runtime origin outside production only', () => {
    expect(resolveApiUrl({ ...base, prod: false, runtimeValue: 'http://localhost:4140' })).toBe('http://localhost:4140');
  });
});

describe('resolveRegionOrigins', () => {
  const fallback = 'in-mum=http://localhost:5173';

  it('prefers the build-time list', () => {
    expect(resolveRegionOrigins({ buildValue: 'in-mum=https://b.example', runtimeValue: 'in-mum=https://r.example', fallback })).toBe(
      'in-mum=https://b.example',
    );
  });

  it('uses the runtime list when nothing is compiled in', () => {
    expect(resolveRegionOrigins({ buildValue: '', runtimeValue: 'in-mum=https://r.example', fallback })).toBe(
      'in-mum=https://r.example',
    );
  });

  it('keeps the fallback with neither', () => {
    expect(resolveRegionOrigins({ buildValue: undefined, runtimeValue: '', fallback })).toBe(fallback);
  });
});
