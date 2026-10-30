/**
 * Phase C names (section 13.1): the cross-language fixture equals the shared exports, plus the section 3.4 family
 * rule, the section 5.1 op table and the section 3.1 capabilities schema.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as shared from '../src/index.js';
import {
  AGENT_CONTROL_OPS,
  ANDROID_CAPABILITIES,
  CONTROL_OPS,
  agentCapabilitiesSchema,
  agentControlEventSchema,
  agentControlRequestSchema,
  agentLevelAtLeast,
  agentMinLevelFor,
  consentLevelFamily,
  controlRequestSchema,
  levelAtLeast,
} from '../src/index.js';
// @ts-expect-error untyped .mjs helper shared with scripts/gen-agent-fixtures.mjs
import { agentNames, fileLists } from '../../../scripts/agent-fixtures-lib.mjs';

const read = (n: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/agent/${n}`, import.meta.url), 'utf8')) as unknown;
const mods = { alt: false, ctrl: false, meta: false, shift: false };

describe('cross-language name fixtures', () => {
  it('agent-names.json equals the shared exports', () => {
    expect(read('agent-names.json')).toEqual(JSON.parse(JSON.stringify(agentNames(shared))));
  });
  it('file-lists.json equals the shared exports', () => {
    expect(read('file-lists.json')).toEqual(JSON.parse(JSON.stringify(fileLists(shared))));
  });
});

describe('consent level families (section 3.4)', () => {
  it('branches on the tier and never mixes families', () => {
    expect(consentLevelFamily('p3_portable')).toBe('p3');
    expect(consentLevelFamily('p2_extension')).toBe('p2');
    expect(consentLevelFamily('p1_browser')).toBe('p2');
    expect(agentLevelAtLeast('elevated', 'control')).toBe(true);
    expect(agentLevelAtLeast('view', 'control')).toBe(false);
    expect(() => agentLevelAtLeast('tab_control' as never, 'view')).toThrow();
  });
  it('a P3 level never reaches levelAtLeast', () => {
    expect(() => levelAtLeast('elevated' as never, 'view')).toThrow();
  });
});

describe('agent control ops (section 5.1)', () => {
  it('P3 and P2 op names are disjoint except the reused B op level.request', () => {
    const shared2 = AGENT_CONTROL_OPS.filter((op) => (CONTROL_OPS as readonly string[]).includes(op));
    expect(shared2).toEqual(['level.request']);
  });
  it('minimum levels', () => {
    expect(agentMinLevelFor('os.monitors')).toBe('view');
    expect(agentMinLevelFor('os.pointer')).toBe('control');
    expect(agentMinLevelFor('os.input_lock')).toBe('elevated');
    expect(agentMinLevelFor('playbook.run', { requiresElevation: false })).toBe('control');
    expect(agentMinLevelFor('playbook.run', { requiresElevation: true })).toBe('elevated');
  });
  it('strict args', () => {
    const base = { t: 'ctl.req', id: 'r1', ts: 1 };
    const ok = (op: string, args: unknown) => agentControlRequestSchema.safeParse({ ...base, op, args }).success;
    expect(ok('os.pointer', { monitorId: 1, kind: 'click', nx: 0.5, ny: 0.25, button: 0, modifiers: mods })).toBe(true);
    expect(ok('os.pointer', { monitorId: 17, kind: 'click', nx: 0.5, ny: 0.25, modifiers: mods })).toBe(false);
    expect(ok('os.pointer', { monitorId: 1, kind: 'click', nx: 1.5, ny: 0, modifiers: mods })).toBe(false);
    expect(ok('os.pointer', { monitorId: 1, kind: 'click', nx: 0.5, ny: 0.5, modifiers: {} })).toBe(false);
    expect(ok('os.monitor.select', { monitorIds: [1, 1] })).toBe(false);
    expect(ok('os.text', { text: 'x'.repeat(1025) })).toBe(false);
    expect(ok('os.scroll', { monitorId: 1, nx: 0, ny: 0, dx: 0, dy: 21 })).toBe(false);
    expect(ok('os.monitors', { extra: 1 })).toBe(false);
    expect(ok('tab.list', {})).toBe(false);
    expect(
      ok('playbook.run', {
        runId: 'a'.repeat(32),
        playbookId: '6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
        bodyHash: 'b'.repeat(64),
        body: 'Get-Date',
        interpreter: 'powershell',
        args: { name: 'x' },
        requiresElevation: false,
        timeoutSec: 120,
      }),
    ).toBe(true);
    // A P3 op is not a B control request (no relay fallback can carry it).
    expect(controlRequestSchema.safeParse({ ...base, op: 'os.text', args: { text: 'x' } }).success).toBe(false);
  });
  it('events', () => {
    const e = { t: 'ctl.event', ts: 1 };
    expect(agentControlEventSchema.safeParse({ ...e, kind: 'input_blocked', cause: 'secure_window' }).success).toBe(
      true,
    );
    expect(
      agentControlEventSchema.safeParse({ ...e, kind: 'capture', monitorId: 1, path: 'projection', cause: 'start' })
        .success,
    ).toBe(true);
    expect(
      agentControlEventSchema.safeParse({
        ...e,
        kind: 'monitors',
        monitors: [
          { id: 1, name: 'Phone screen', primary: true, x: 0, y: 0, width: 1080, height: 2400, scale: 4.38, mid: '0' },
        ],
        selected: [1],
      }).success,
    ).toBe(true);
  });
});

describe('agent capabilities (section 3.1)', () => {
  it('accepts the Windows example and the Android subset, rejects unknown features', () => {
    expect(
      agentCapabilitiesSchema.safeParse({
        monitors: 2,
        elevation: 'user',
        features: [
          'screen',
          'multi_monitor',
          'input',
          'input_text',
          'clipboard',
          'files',
          'chat',
          'voice',
          'elevation',
          'playbooks',
        ],
        encoders: ['h264', 'vp8', 'vp9'],
        hwEncoder: true,
        interpreters: ['powershell', 'cmd'],
      }).success,
    ).toBe(true);
    expect(agentCapabilitiesSchema.parse(ANDROID_CAPABILITIES)).toEqual(ANDROID_CAPABILITIES);
    expect(agentCapabilitiesSchema.safeParse({ ...ANDROID_CAPABILITIES, features: ['teleport'] }).success).toBe(false);
    expect(agentCapabilitiesSchema.safeParse({ ...ANDROID_CAPABILITIES, monitors: 17 }).success).toBe(false);
  });
});
