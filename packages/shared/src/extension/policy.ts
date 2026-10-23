/**
 * Org extension policy (docs/specs/phase-b-contracts.md sections 5.2, 9.4, 11.2): schema, defaults, the PATCH body,
 * the managed (enterprise) policy of the Desk and `effectiveMaxLevel`, the single level-cap rule used by the server,
 * the extension and the console.
 */
import { z } from 'zod';
import { CONSENT_LEVELS, LIMITS, minLevel, type ConsentLevel } from '../enums.js';
import { sanitiseText } from '../audit/sanitise.js';
import { utf8Encode } from '../encoding.js';
import { normaliseHostPattern } from './deny-list.js';

const level = z.enum(CONSENT_LEVELS);

const hostPattern = z
  .string()
  .max(1000)
  .transform((s, ctx) => {
    const n = normaliseHostPattern(s);
    if (!n) {
      ctx.addIssue({ code: 'custom', message: `not a hostname or *.hostname: ${s.slice(0, 80)}` });
      return z.NEVER;
    }
    return n;
  });

const denyList = z
  .array(hostPattern)
  .max(LIMITS.policyDenyListMax)
  .transform((l) => [...new Set(l)]);

const selector = z
  .string()
  .max(LIMITS.policySelectorMax)
  .transform((s) => sanitiseText(s, LIMITS.policySelectorMax).trim())
  .refine((s) => s.length > 0, 'selector must not be empty');
const selectors = z.array(selector).max(LIMITS.policySelectorsMax);

const isoOrNull = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .nullable();

const policyShape = {
  denyList,
  maskSelectors: selectors,
  blockSelectors: selectors,
  defaultConsentLevel: level,
  maxConsentLevel: level,
  allowDeepControl: z.boolean(),
  allowAllTabs: z.boolean(),
  allowUnmask: z.boolean(),
  backstageAllowed: z.boolean(),
  recordMirror: z.boolean(),
  recordRevealed: z.boolean(),
  allowRelayFallback: z.boolean(),
  titlePrefix: z.boolean(),
  /** Reserved in Phase B: accepted, stored, ignored (remote assets never load in the replayer). */
  allowRemoteAssets: z.boolean(),
  updatedAt: isoOrNull,
};

export type ExtensionPolicy = {
  denyList: string[];
  maskSelectors: string[];
  blockSelectors: string[];
  defaultConsentLevel: ConsentLevel;
  maxConsentLevel: ConsentLevel;
  allowDeepControl: boolean;
  allowAllTabs: boolean;
  allowUnmask: boolean;
  backstageAllowed: boolean;
  recordMirror: boolean;
  recordRevealed: boolean;
  allowRelayFallback: boolean;
  titlePrefix: boolean;
  allowRemoteAssets: boolean;
  updatedAt: string | null;
};

export const DEFAULT_EXTENSION_POLICY: Readonly<ExtensionPolicy> = Object.freeze({
  denyList: [],
  maskSelectors: [],
  blockSelectors: [],
  defaultConsentLevel: 'tab_control',
  maxConsentLevel: 'deep_control',
  allowDeepControl: true,
  allowAllTabs: true,
  allowUnmask: true,
  backstageAllowed: true,
  recordMirror: false,
  recordRevealed: false,
  allowRelayFallback: true,
  titlePrefix: true,
  allowRemoteAssets: false,
  updatedAt: null,
});

export const EXTENSION_POLICY_FIELDS = Object.keys(DEFAULT_EXTENSION_POLICY) as (keyof ExtensionPolicy)[];

/** The Desk employer's `chrome.storage.managed` policy (section 9.4); unknown keys are dropped. */
export const managedPolicySchema = z.object({
  apiOrigin: z.string().max(200).optional(),
  deskLabel: z.string().max(80).optional(),
  extraDenyList: z.array(z.string().max(LIMITS.policyHostPatternMax)).max(LIMITS.policyDenyListMax).optional(),
  maxConsentLevel: level.optional(),
  allowDeepControl: z.boolean().optional(),
  allowAllTabs: z.boolean().optional(),
  allowBackstage: z.boolean().optional(),
  allowUnmask: z.boolean().optional(),
});
export type ManagedPolicy = z.infer<typeof managedPolicySchema>;

/**
 * The lowest of `policy.maxConsentLevel`, `in_page` when deep control is off, and the managed caps (section 5.2).
 * The server calls it without `managed`.
 */
export function effectiveMaxLevel(
  policy: Pick<ExtensionPolicy, 'maxConsentLevel' | 'allowDeepControl'>,
  managed?: Pick<ManagedPolicy, 'maxConsentLevel' | 'allowDeepControl'>,
): ConsentLevel {
  let out: ConsentLevel = policy.maxConsentLevel;
  if (!policy.allowDeepControl) out = minLevel(out, 'in_page');
  if (managed?.maxConsentLevel) out = minLevel(out, managed.maxConsentLevel);
  if (managed?.allowDeepControl === false) out = minLevel(out, 'in_page');
  return out;
}

function within(a: ConsentLevel, cap: ConsentLevel): boolean {
  return minLevel(a, cap) === a;
}

function sizeOk(p: ExtensionPolicy): boolean {
  return utf8Encode(JSON.stringify(p)).length <= LIMITS.policyJsonMaxBytes;
}

/** A complete policy (the GET body minus `builtinDenyList`; the `session.created.extension.policy` value). */
export const extensionPolicySchema = z.strictObject(policyShape).superRefine((p, ctx) => {
  if (!within(p.defaultConsentLevel, effectiveMaxLevel(p)))
    ctx.addIssue({ code: 'custom', path: ['defaultConsentLevel'], message: 'defaultConsentLevel exceeds the maximum level' });
  if (!sizeOk(p as ExtensionPolicy)) ctx.addIssue({ code: 'custom', message: `policy JSON exceeds ${LIMITS.policyJsonMaxBytes} bytes` });
});

/** GET / PATCH `/orgs/current/policy/extension` response (11.3): the merged policy plus the built-in list. */
export const extensionPolicyResponseSchema = z.strictObject({ ...policyShape, builtinDenyList: z.array(z.string()) });

/** PATCH body: any subset of the policy fields; `null` resets a field to its default. `updatedAt` is server-set. */
export const extensionPolicyPatchSchema = z.strictObject({
  denyList: denyList.nullable().optional(),
  maskSelectors: selectors.nullable().optional(),
  blockSelectors: selectors.nullable().optional(),
  defaultConsentLevel: level.nullable().optional(),
  maxConsentLevel: level.nullable().optional(),
  allowDeepControl: z.boolean().nullable().optional(),
  allowAllTabs: z.boolean().nullable().optional(),
  allowUnmask: z.boolean().nullable().optional(),
  backstageAllowed: z.boolean().nullable().optional(),
  recordMirror: z.boolean().nullable().optional(),
  recordRevealed: z.boolean().nullable().optional(),
  allowRelayFallback: z.boolean().nullable().optional(),
  titlePrefix: z.boolean().nullable().optional(),
  allowRemoteAssets: z.boolean().nullable().optional(),
});
export type ExtensionPolicyPatch = z.output<typeof extensionPolicyPatchSchema>;

const FIELD_SCHEMAS = policyShape as unknown as Record<keyof ExtensionPolicy, z.ZodType>;

/**
 * The stored (jsonb) policy merged over the defaults on every read (section 11.1). Each field is validated on its
 * own; a missing or invalid stored field reads as its default, so a bad row can never widen a session.
 */
export function mergePolicy(stored: unknown): ExtensionPolicy {
  const out: Record<string, unknown> = { ...DEFAULT_EXTENSION_POLICY };
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const k of EXTENSION_POLICY_FIELDS) {
      const v = (stored as Record<string, unknown>)[k];
      if (v === undefined) continue;
      const r = FIELD_SCHEMAS[k].safeParse(v);
      if (r.success) out[k] = r.data;
    }
  }
  const p = out as ExtensionPolicy;
  const cap = effectiveMaxLevel(p);
  if (!within(p.defaultConsentLevel, cap)) p.defaultConsentLevel = cap;
  return p;
}

/**
 * Applies a validated PATCH to a policy: the next policy, the names of the fields the patch carried (for
 * `org.policy_updated`) and a validation error (`defaultConsentLevel` above the cap, JSON over 32 KiB) or null.
 */
export function applyPolicyPatch(
  current: ExtensionPolicy,
  patch: ExtensionPolicyPatch,
): { next: ExtensionPolicy; fields: string[]; error: string | null } {
  const next: Record<string, unknown> = { ...current };
  const fields: string[] = [];
  for (const k of EXTENSION_POLICY_FIELDS) {
    if (k === 'updatedAt') continue;
    const v = (patch as Record<string, unknown>)[k];
    if (v === undefined) continue;
    fields.push(k);
    next[k] = v === null ? DEFAULT_EXTENSION_POLICY[k] : v;
  }
  const p = next as ExtensionPolicy;
  let error: string | null = null;
  if (!within(p.defaultConsentLevel, effectiveMaxLevel(p))) error = 'defaultConsentLevel exceeds the maximum level';
  else if (!sizeOk(p)) error = `policy JSON exceeds ${LIMITS.policyJsonMaxBytes} bytes`;
  return { next: p, fields, error };
}
