/**
 * Phase D native-tier rule (docs/specs/phase-d-contracts.md section 16.2, P1): every branch that used to mean "a
 * native agent session" must ask the shared helper `isNativeTier(tier)` rather than compare against `p3_portable`
 * alone, or a `p4_installed` session silently takes the P2 path. Section 15.3 hands that rule to this file, and no
 * runtime test can see it (the P3 branches keep working either way), so it is checked at the source: each call site
 * the index names must use the helper and must not test the portable tier on its own, the files the index marks as
 * deliberately portable-only must keep doing so, and the list here must still match the index itself.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = new URL('../../../', import.meta.url);
const SPEC = 'docs/specs/phase-d-contracts.md';

/** Section 16.2: the call sites that must read `isNativeTier(tier)`. */
const NATIVE_TIER_SITES = [
  'apps/api/src/signal/desk-consent.ts',
  'apps/api/src/signal/desk-events.ts',
  'apps/api/src/signal/desk-p3.ts',
  'apps/api/src/signal/conn.ts',
  'apps/api/src/signal/agent-manifest.ts',
  'apps/api/src/signal/messages.ts',
  'apps/api/src/signal/recorder.ts',
  'apps/api/src/routes/session-events.ts',
  'apps/api/src/routes/playbooks.ts',
  'apps/api/src/routes/internal-recordings.ts',
  'apps/api/src/services/scope.ts',
  'apps/web/src/assist/console/ConsolePage.tsx',
];

/** The same index's last row: the portable download / join / sidecar / desk-code flows, P3-only on purpose. */
const PORTABLE_ONLY = [
  'apps/api/src/routes/download.ts',
  'apps/api/src/routes/tokens.ts',
  'apps/api/src/signal/handover.ts',
];

/** A tier compared against the portable tier alone, in either direction and either quote style. */
const PORTABLE_COMPARISON = /(?:[!=]==\s*['"]p3_portable['"])|(?:['"]p3_portable['"]\s*[!=]==)/;

/** Source with its comments removed, so prose naming `p3_portable` never reads as a branch. */
function code(rel: string): string {
  let text: string;
  try {
    text = readFileSync(fileURLToPath(new URL(rel, REPO)), 'utf8');
  } catch {
    throw new Error(`${rel}: listed in ${SPEC} section 16.2 but not found; update both the index and this test`);
  }
  // Comment lines are blanked rather than dropped, so a reported line number is the real one.
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*(?:\/\/|\*)/.test(line) ? '' : line))
    .join('\n');
}

describe('section 16.2: both native tiers take the native code paths', () => {
  it.each(NATIVE_TIER_SITES)('%s asks isNativeTier, never the portable tier alone', (rel) => {
    const src = code(rel);
    expect(src, `${rel} must call isNativeTier (section 16.2 P1)`).toContain('isNativeTier(');
    const offenders = src
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter((l) => PORTABLE_COMPARISON.test(l.line));
    expect(
      offenders,
      `${rel} tests the portable tier on its own; use isNativeTier so p4_installed takes the same path:\n${offenders
        .map((o) => `  line ${o.n}: ${o.line}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('the desk socket expects a native client for p4_installed too', () => {
    const src = code('apps/api/src/signal/desk.ts');
    // The one `p3_portable` branch left in this file is the desk-code retirement the index keeps portable-only.
    expect(src).toMatch(/p3_portable:\s*'native'/);
    expect(src).toMatch(/p4_installed:\s*'native'/);
  });

  it.each(PORTABLE_ONLY)('%s stays deliberately portable-only', (rel) => {
    const src = code(rel);
    expect(src, `${rel} no longer tests p3_portable: section 16.2's "unchanged, deliberately" row needs updating`).toMatch(
      PORTABLE_COMPARISON,
    );
  });

  it('the list above still matches the section 16.2 index', () => {
    const spec = readFileSync(fileURLToPath(new URL(SPEC, REPO)), 'utf8');
    const index = spec.slice(spec.indexOf('### 16.2'));
    expect(index.length).toBeGreaterThan(0);
    const rows = index
      .split('\n')
      .filter((line) => line.includes('isNativeTier') && !line.includes('deliberately'))
      .map((line) => /^\|\s*`(apps\/(?:api|web)\/src\/[^`]+)`/.exec(line)?.[1])
      .filter((p): p is string => p !== undefined);
    expect(rows.length, 'no native-tier rows found: has section 16.2 been reshaped?').toBeGreaterThan(5);
    for (const path of rows) {
      expect(NATIVE_TIER_SITES, `${SPEC} names ${path} as an isNativeTier call site; add it to NATIVE_TIER_SITES`).toContain(path);
    }
  });
});
