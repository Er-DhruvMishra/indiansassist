import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// findBy* / waitFor default to 1 s, which a lazy route's first render can exceed when `pnpm -r test` runs every
// package at once; a passing wait returns as soon as it matches, so only a genuine failure waits the longer bound.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  try {
    sessionStorage.clear();
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

// jsdom has no canvas implementation; return null so drawing code takes its guarded no-op path quietly.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
}
