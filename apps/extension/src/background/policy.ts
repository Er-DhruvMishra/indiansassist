/**
 * The policy in force on this Desk (sections 3.1, 5.2, 8.2, 9.4): the org policy from the live `session.created`
 * combined with the Desk employer's managed policy, always the stricter of the two.
 */
import {
  effectiveDenyList,
  effectiveMaxLevel,
  levelAtLeast,
  minLevel,
  type ConsentLevel,
  type ExtensionPolicy,
  type ManagedPolicy,
} from '@indiansassist/shared';
import type { CapturePolicy } from '../shared/bus-schemas';

export type EffectivePolicy = {
  policy: ExtensionPolicy;
  maxLevel: ConsentLevel;
  defaultLevel: ConsentLevel;
  allowAllTabs: boolean;
  backstageAllowed: boolean;
  allowUnmask: boolean;
  denyList: string[];
  /** True when the managed policy lowered any option (the consent window says so). */
  managedLimited: boolean;
};

export function effectivePolicy(policy: ExtensionPolicy, managed: ManagedPolicy = {}): EffectivePolicy {
  const orgMax = effectiveMaxLevel(policy);
  const maxLevel = effectiveMaxLevel(policy, managed);
  const allowAllTabs = policy.allowAllTabs && managed.allowAllTabs !== false;
  const backstageAllowed = policy.backstageAllowed && managed.allowBackstage !== false;
  const allowUnmask = policy.allowUnmask && managed.allowUnmask !== false;
  const managedLimited =
    maxLevel !== orgMax ||
    allowAllTabs !== policy.allowAllTabs ||
    backstageAllowed !== policy.backstageAllowed ||
    allowUnmask !== policy.allowUnmask ||
    (managed.extraDenyList?.length ?? 0) > 0;
  return {
    policy,
    maxLevel,
    defaultLevel: minLevel(policy.defaultConsentLevel, maxLevel),
    allowAllTabs,
    backstageAllowed,
    allowUnmask,
    denyList: effectiveDenyList(policy.denyList, managed.extraDenyList),
    managedLimited,
  };
}

/** True when `level` may be granted under the effective policy. */
export function levelAllowed(e: EffectivePolicy, level: ConsentLevel): boolean {
  return levelAtLeast(e.maxLevel, level);
}

export function capturePolicy(e: EffectivePolicy): CapturePolicy {
  return {
    maskSelectors: [...e.policy.maskSelectors],
    blockSelectors: [...e.policy.blockSelectors],
    titlePrefix: e.policy.titlePrefix,
    allowUnmask: e.allowUnmask,
  };
}
