import { describe, expect, it } from 'vitest';
import {
  applyPolicyPatch,
  DEFAULT_EXTENSION_POLICY,
  effectiveMaxLevel,
  extensionPolicyPatchSchema,
  extensionPolicyResponseSchema,
  extensionPolicySchema,
  levelAtLeast,
  managedPolicySchema,
  mergePolicy,
  type ExtensionPolicy,
} from '../src/index.js';

describe('extension policy', () => {
  it('the defaults validate and merge over an empty row', () => {
    expect(extensionPolicySchema.parse({ ...DEFAULT_EXTENSION_POLICY })).toEqual(DEFAULT_EXTENSION_POLICY);
    expect(mergePolicy({})).toEqual(DEFAULT_EXTENSION_POLICY);
    expect(mergePolicy(null)).toEqual(DEFAULT_EXTENSION_POLICY);
    expect(extensionPolicyResponseSchema.safeParse({ ...DEFAULT_EXTENSION_POLICY, builtinDenyList: ['a.test'] }).success).toBe(true);
  });

  it('mergePolicy keeps valid stored fields, drops invalid ones and clamps the default level', () => {
    const p = mergePolicy({ allowAllTabs: false, denyList: ['Example.com'], maxConsentLevel: 'bogus', extra: 1 });
    expect(p.allowAllTabs).toBe(false);
    expect(p.denyList).toEqual(['example.com']);
    expect(p.maxConsentLevel).toBe('deep_control');
    expect(p).not.toHaveProperty('extra');
    const clamped = mergePolicy({ maxConsentLevel: 'view', defaultConsentLevel: 'in_page' });
    expect(clamped.defaultConsentLevel).toBe('view');
  });

  it('effectiveMaxLevel takes the lowest of policy, allowDeepControl and managed caps', () => {
    const base: ExtensionPolicy = { ...DEFAULT_EXTENSION_POLICY };
    expect(effectiveMaxLevel(base)).toBe('deep_control');
    expect(effectiveMaxLevel({ ...base, allowDeepControl: false })).toBe('in_page');
    expect(effectiveMaxLevel({ ...base, maxConsentLevel: 'tab_control' })).toBe('tab_control');
    expect(effectiveMaxLevel(base, { maxConsentLevel: 'view' })).toBe('view');
    expect(effectiveMaxLevel(base, { allowDeepControl: false })).toBe('in_page');
    expect(effectiveMaxLevel({ ...base, maxConsentLevel: 'tab_control' }, { allowDeepControl: false })).toBe('tab_control');
    expect(levelAtLeast('deep_control', 'in_page')).toBe(true);
    expect(levelAtLeast('view', 'tab_control')).toBe(false);
  });

  it('the full schema refuses a default above the cap', () => {
    const r = extensionPolicySchema.safeParse({ ...DEFAULT_EXTENSION_POLICY, allowDeepControl: false, defaultConsentLevel: 'deep_control' });
    expect(r.success).toBe(false);
  });

  it('patch: validates hosts and selectors, null resets, unknown keys fail', () => {
    expect(extensionPolicyPatchSchema.safeParse({ denyList: ['example.com:80'] }).success).toBe(false);
    expect(extensionPolicyPatchSchema.safeParse({ maskSelectors: ['x'.repeat(201)] }).success).toBe(false);
    expect(extensionPolicyPatchSchema.safeParse({ maskSelectors: Array.from({ length: 51 }, () => '.a') }).success).toBe(false);
    expect(extensionPolicyPatchSchema.safeParse({ updatedAt: null }).success).toBe(false);
    expect(extensionPolicyPatchSchema.safeParse({ nope: true }).success).toBe(false);
    const patch = extensionPolicyPatchSchema.parse({ allowAllTabs: false, denyList: ['*.Bank.test', '*.bank.test'], titlePrefix: null });
    const { next, fields, error } = applyPolicyPatch({ ...DEFAULT_EXTENSION_POLICY, titlePrefix: false }, patch);
    expect(error).toBeNull();
    expect(fields.sort()).toEqual(['allowAllTabs', 'denyList', 'titlePrefix']);
    expect(next.denyList).toEqual(['*.bank.test']);
    expect(next.titlePrefix).toBe(true);
  });

  it('patch: default above cap and oversize JSON are errors', () => {
    const p1 = applyPolicyPatch({ ...DEFAULT_EXTENSION_POLICY }, extensionPolicyPatchSchema.parse({ maxConsentLevel: 'view' }));
    expect(p1.error).toMatch(/defaultConsentLevel/);
    const many = Array.from({ length: 500 }, (_, i) => `host-${i}-${'x'.repeat(50)}.example.test`);
    const sel = Array.from({ length: 50 }, (_, i) => `.c${i}${'y'.repeat(190)}`);
    const p2 = applyPolicyPatch({ ...DEFAULT_EXTENSION_POLICY }, extensionPolicyPatchSchema.parse({ denyList: many, maskSelectors: sel, blockSelectors: sel }));
    expect(p2.error).toMatch(/32768/);
  });

  it('managed policy drops unknown keys', () => {
    expect(managedPolicySchema.parse({ maxConsentLevel: 'in_page', other: 1 })).toEqual({ maxConsentLevel: 'in_page' });
  });
});
