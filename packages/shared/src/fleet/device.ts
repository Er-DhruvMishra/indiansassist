/**
 * Phase D device wire objects (docs/specs/phase-d-contracts.md sections 3.1-3.4, 12.3, 13.1a): the REST `Device`, the
 * reported facts (`ServiceCapabilities`, `AmtInventory`, `LanSegment`, `InteractiveState`), the enrollment request /
 * reply and the region-signed `enroll.iaconfig` (the only enrollment carrier).
 */
import { z } from 'zod';
import { canonicalJson } from '../canonical.js';
import { signBytes, verifyBytes, type PublicKeyLike } from '../crypto.js';
import { utf8Encode } from '../encoding.js';
import {
  DEVICE_PLATFORMS,
  DEVICE_STATUSES,
  INTERACTIVE_STATES,
  LIMITS,
  PLAYBOOK_INTERPRETERS,
  SERVICE_FEATURES,
  TAMPER_STATES,
  VIDEO_ENCODERS,
} from '../enums.js';
import { REGIONS } from '../regions.js';
import { sanitiseText } from '../audit/sanitise.js';
import { unattendedPolicySchema } from './policy.js';

const unique = <T>(a: readonly T[]) => new Set(a).size === a.length;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'expected a lower-case uuid');
const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lower-case hex chars');
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'ISO 8601 UTC with milliseconds');
export const b64u32Schema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'base64url of 32 bytes');
export const b64u16Schema = z.string().regex(/^[A-Za-z0-9_-]{22}$/, 'base64url of 16 bytes');
export const b64u64Schema = z.string().regex(/^[A-Za-z0-9_-]{86}$/, 'base64url of 64 bytes');

/** `hwFingerprint`: sha256 hex of the machine facts the service hashes (re-enrollment detection, rule 3.7a). */
export const HW_FINGERPRINT_RE = /^[0-9a-f]{64}$/;
/** `wakeMac`: the wake NIC's MAC, 12 lower-case hex (rule 8.2c); never stored in plaintext. */
export const WAKE_MAC_RE = /^[0-9a-f]{12}$/;
export const wakeMacSchema = z.string().regex(WAKE_MAC_RE, '12 lower-case hex chars');

/** Section 3.4 `InteractiveState`; "present" = `state === 'active'`. */
export const interactiveStateSchema = z.strictObject({
  state: z.enum(INTERACTIVE_STATES),
  idleSec: z.number().int().nonnegative().nullable(),
  at: z.number().int().nonnegative(),
});
export type InteractiveState = z.infer<typeof interactiveStateSchema>;

/** Rule 8.2a: org-salted hashes computed on the device (raw addresses never travel). */
export const lanSegmentSchema = z.strictObject({
  subnetHash: hex64,
  gatewayMacHash: hex64,
  dhcpDomain: z.string().max(255).optional(),
});
export type LanSegment = z.infer<typeof lanSegmentSchema>;

/** Rule 8.4a. */
export const amtInventorySchema = z.strictObject({
  present: z.boolean(),
  provisioned: z.boolean(),
  version: z.string().max(32).optional(),
  host: z.string().max(255).optional(),
  tls: z.boolean(),
  powerState: z.number().int().optional(),
});
export type AmtInventory = z.infer<typeof amtInventorySchema>;

/** Section 13.1a `ServiceCapabilities`, strict; a superset of the C `AgentCapabilities`. */
export const serviceCapabilitiesSchema = z.strictObject({
  monitors: z.number().int().min(1).max(16),
  elevation: z.literal('admin'),
  features: z.array(z.enum(SERVICE_FEATURES)).max(SERVICE_FEATURES.length).refine(unique, 'unique'),
  encoders: z.array(z.enum(VIDEO_ENCODERS)).max(VIDEO_ENCODERS.length).refine(unique, 'unique'),
  hwEncoder: z.boolean(),
  interpreters: z.array(z.enum(PLAYBOOK_INTERPRETERS)).max(PLAYBOOK_INTERPRETERS.length).refine(unique, 'unique'),
  serviceVersion: z.string().min(1).max(32),
});
export type ServiceCapabilities = z.infer<typeof serviceCapabilitiesSchema>;

const deviceName = z
  .string()
  .max(1000)
  .transform((s) => sanitiseText(s, 80).trim())
  .refine((s) => s.length >= 1, 'name is 1..80 characters');
export const deviceTagSchema = z
  .string()
  .max(200)
  .transform((s) => sanitiseText(s, 40).trim())
  .refine((s) => s.length >= 1, 'a tag is 1..40 characters');
export const deviceTagsSchema = z
  .array(deviceTagSchema)
  .max(LIMITS.deviceTagsMax)
  .transform((t) => [...new Set(t)]);

/** The machine facts of an enrollment request (section 3.2). */
export const deviceMachineSchema = z.strictObject({
  name: deviceName,
  platform: z.literal('windows'),
  osVersion: z.string().min(1).max(32),
  arch: z.enum(['x64', 'arm64']),
  serviceVersion: z.string().min(1).max(32),
  hwFingerprint: z.string().regex(HW_FINGERPRINT_RE, '64 lower-case hex chars'),
  wakeMac: wakeMacSchema.nullable(),
  amt: amtInventorySchema.nullable(),
  capabilities: serviceCapabilitiesSchema,
  interactive: interactiveStateSchema,
});
export type DeviceMachine = z.infer<typeof deviceMachineSchema>;

/** `POST /api/v1/devices/enroll` body (section 3.2). */
export const deviceEnrollRequestSchema = z.strictObject({
  enrollConfig: z
    .string()
    .min(1)
    .refine((s) => utf8Encode(s).length <= LIMITS.enrollConfigMaxBytes, `at most ${LIMITS.enrollConfigMaxBytes} bytes`),
  devicePublicKey: b64u32Schema,
  deviceKexPublicKey: b64u32Schema,
  deviceKeyProof: b64u64Schema,
  machine: deviceMachineSchema,
});
export type DeviceEnrollRequest = z.output<typeof deviceEnrollRequestSchema>;

/** `201` reply of the enrollment (section 3.2). */
export const deviceEnrollReplySchema = z.strictObject({
  deviceId: uuid,
  orgId: uuid,
  region: z.enum(REGIONS),
  apiOrigin: z.string(),
  signalUrl: z.string(),
  keyId: z.string().regex(/^[0-9a-f]{16}$/),
  group: z.strictObject({ id: uuid, name: z.string() }).nullable(),
  policy: unattendedPolicySchema,
});
export type DeviceEnrollReply = z.infer<typeof deviceEnrollReplySchema>;

/** `Device` (REST, section 13.1a): the list / detail object of the fleet console. */
export const deviceSchema = z.object({
  id: uuid,
  name: z.string(),
  platform: z.enum(DEVICE_PLATFORMS),
  status: z.enum(DEVICE_STATUSES),
  online: z.boolean(),
  keyId: z.string().regex(/^[0-9a-f]{16}$/).nullable(),
  osVersion: z.string().nullable(),
  arch: z.string().nullable(),
  agentVersion: z.string().nullable(),
  serviceVersion: z.string().nullable(),
  groupId: uuid.nullable(),
  tags: z.array(z.string()),
  capabilities: serviceCapabilitiesSchema.or(z.record(z.string(), z.unknown())),
  interactive: interactiveStateSchema.nullable(),
  amt: amtInventorySchema.nullable(),
  tamperState: z.enum(TAMPER_STATES),
  lanSegmentHash: hex64.nullable(),
  notifyEmail: z.string().nullable(),
  lastSeenAt: iso.nullable(),
  firstSeenAt: iso.nullable(),
  enrolledAt: iso.nullable(),
  lastIp: z.string().nullable(),
});
export type Device = z.infer<typeof deviceSchema>;

// ---------- signed enroll.iaconfig (section 12.3) ----------

/**
 * Phase C section 2.4 rule, enforced identically by the MSI installer: plain `http` / `ws` only for `localhost` or
 * `127.0.0.1` (development); every other host must be `https` / `wss`.
 */
const LOCAL_HOST = '(?:localhost|127\\.0\\.0\\.1)';
const PORT = '(?::\\d{1,5})?';
export const ENROLL_API_ORIGIN_RE = new RegExp(`^(?:https://[A-Za-z0-9.-]+${PORT}|http://${LOCAL_HOST}${PORT})$`);
export const ENROLL_SIGNAL_URL_RE = new RegExp(`^(?:wss://[A-Za-z0-9.-]+${PORT}|ws://${LOCAL_HOST}${PORT})/signal/device$`);

/** `enroll.iaconfig`, strict; `sig` by the region's token-signing key over the canonical JSON without `sig`. */
export const enrollConfigSchema = z.strictObject({
  v: z.literal(1),
  apiOrigin: z.string().max(200).regex(ENROLL_API_ORIGIN_RE, 'an https origin without a path (plain http only for localhost)'),
  signalUrl: z.string().max(300).regex(ENROLL_SIGNAL_URL_RE, 'the region wss://.../signal/device URL (plain ws only for localhost)'),
  region: z.enum(REGIONS),
  token: z.string().min(1).max(4096),
  groupId: uuid.nullable(),
  kid: z.string().regex(/^[0-9a-f]{16}$/),
  sig: b64u64Schema,
});
export type EnrollConfig = z.infer<typeof enrollConfigSchema>;
export type EnrollConfigFields = Omit<EnrollConfig, 'sig'>;

export function enrollConfigSigningInput(cfg: EnrollConfigFields | EnrollConfig): Uint8Array {
  const { sig: _sig, ...rest } = cfg as EnrollConfig;
  void _sig;
  return utf8Encode(canonicalJson(rest));
}

/** Signs and serialises an `enroll.iaconfig` (sorted keys, <= LIMITS.enrollConfigMaxBytes). */
export async function signEnrollConfig(fields: EnrollConfigFields, seedHex: string): Promise<string> {
  // Never sign a config the installer (or verifyEnrollConfig) would reject.
  enrollConfigSchema.omit({ sig: true }).parse(fields);
  const sig = await signBytes(enrollConfigSigningInput(fields), seedHex);
  const text = canonicalJson({ ...fields, sig });
  if (utf8Encode(text).length > LIMITS.enrollConfigMaxBytes) throw new Error('enroll.iaconfig exceeds 16 KiB');
  return text;
}

/** Parses and verifies an `enroll.iaconfig` against a key set; null when malformed, oversize or not signed by a known key. */
export async function verifyEnrollConfig(text: string, keys: readonly PublicKeyLike[]): Promise<EnrollConfig | null> {
  if (typeof text !== 'string' || utf8Encode(text).length > LIMITS.enrollConfigMaxBytes) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = enrollConfigSchema.safeParse(raw);
  if (!r.success) return null;
  return (await verifyBytes(enrollConfigSigningInput(r.data), r.data.sig, r.data.kid, keys)) ? r.data : null;
}
