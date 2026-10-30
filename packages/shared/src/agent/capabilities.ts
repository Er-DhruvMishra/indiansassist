/** Phase C section 3.1: `desk.hello.client.capabilities` of a native Desk (agent or Android host). */
import { z } from 'zod';
import { AGENT_FEATURES, ELEVATION_LEVELS, PLAYBOOK_INTERPRETERS, VIDEO_ENCODERS } from '../enums.js';

const unique = <T>(a: readonly T[]) => new Set(a).size === a.length;

export const agentCapabilitiesSchema = z.strictObject({
  monitors: z.number().int().min(1).max(16),
  elevation: z.enum(ELEVATION_LEVELS),
  features: z.array(z.enum(AGENT_FEATURES)).max(AGENT_FEATURES.length).refine(unique, 'unique'),
  encoders: z.array(z.enum(VIDEO_ENCODERS)).max(VIDEO_ENCODERS.length).refine(unique, 'unique'),
  hwEncoder: z.boolean(),
  interpreters: z.array(z.enum(PLAYBOOK_INTERPRETERS)).max(PLAYBOOK_INTERPRETERS.length).refine(unique, 'unique'),
});
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;

/** Section 12.4: what the Android host sends (no multi_monitor, clipboard, elevation, playbooks). */
export const ANDROID_CAPABILITIES: AgentCapabilities = {
  monitors: 1,
  elevation: 'user',
  features: ['screen', 'input', 'input_text', 'nav', 'files', 'chat', 'voice'],
  encoders: ['vp8', 'h264'],
  hwEncoder: true,
  interpreters: [],
};
