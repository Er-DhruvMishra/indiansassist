/** REST schemas: error envelope, pagination, health, discovery, auth, orgs, users (contracts 6.1-6.6). */
import { z } from 'zod';
import { API_ERROR_CODES } from '../errors.js';
import { base64Decode } from '../encoding.js';
import { LIMITS } from '../enums.js';
import { sanitiseText, SANITISE_LIMITS } from '../audit/sanitise.js';
import {
  emailSchema,
  hexColorSchema,
  isoTimestampSchema,
  kidSchema,
  packageTierSchema,
  passwordSchema,
  regionSchema,
  slugSchema,
  userRoleSchema,
  userStatusSchema,
  uuidSchema,
} from './common.js';

// ---------- error envelope (6.2) ----------

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES as [string, ...string[]]);
export const apiErrorSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export const apiErrorEnvelopeSchema = z.object({ error: apiErrorSchema });

// ---------- pagination (6.3 Page<T>) ----------

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.pageLimitMax).default(LIMITS.pageLimitDefault),
  cursor: z.string().min(1).max(512).optional(),
});

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

// ---------- health and discovery (3.4, 6.4) ----------

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  region: regionSchema,
  servedRegions: z.array(regionSchema),
  nodeId: z.string(),
  version: z.string(),
  time: isoTimestampSchema,
});

export const wellKnownKeySchema = z.object({
  kid: kidSchema,
  alg: z.literal('Ed25519'),
  pub: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'expected base64url of 32 bytes'),
  createdAt: isoTimestampSchema,
});

export const wellKnownSchema = z.object({
  v: z.literal(1),
  region: regionSchema,
  keys: z.array(wellKnownKeySchema),
  api: z.string(),
  signal: z.string(),
  join: z.string(),
});

// ---------- shared objects (6.3) ----------

export const userSchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  email: z.string(),
  name: z.string(),
  role: userRoleSchema,
  status: userStatusSchema,
  createdAt: isoTimestampSchema,
  lastLoginAt: isoTimestampSchema.nullable(),
});

export const brandingSchema = z.object({
  displayName: z.string().optional(),
  logoData: z.string().optional(),
  accentColor: hexColorSchema.optional(),
  supportEmail: z.string().optional(),
});

export const orgSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  slug: z.string(),
  dataRegion: regionSchema,
  planTier: packageTierSchema,
  branding: brandingSchema,
  createdAt: isoTimestampSchema,
});

export const seatSchema = z.object({
  id: uuidSchema,
  userId: uuidSchema,
  tier: packageTierSchema,
  active: z.boolean(),
});

// ---------- auth (6.5) ----------

export const signupRequestSchema = z.object({
  orgName: z.string().trim().min(1).max(100),
  slug: slugSchema.optional(),
  region: regionSchema.optional(),
  name: z.string().trim().min(1).max(100),
  email: emailSchema,
  password: passwordSchema,
});

export const loginRequestSchema = z.object({
  email: z.string().min(1).max(254),
  password: z.string().min(1).max(LIMITS.passwordMax),
});

export const acceptInviteRequestSchema = z.object({
  invite: z.string().min(1).max(256),
  name: z.string().trim().min(1).max(100),
  password: passwordSchema,
});

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(LIMITS.passwordMax),
  newPassword: passwordSchema,
});

export const signupResponseSchema = z.object({ user: userSchema, org: orgSchema, seat: seatSchema });
export const authResponseSchema = z.object({ user: userSchema, org: orgSchema, seat: seatSchema.nullable() });

// ---------- orgs (6.6) ----------

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/**
 * Validates a branding logo data URL: only `data:image/png;base64,` or `data:image/jpeg;base64,`,
 * decoded size at most 200 KiB, and the decoded bytes must start with the matching magic bytes.
 */
export function isValidLogoData(s: string): boolean {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(s);
  if (!m) return false;
  let bytes: Uint8Array;
  try {
    bytes = base64Decode(m[2]!);
  } catch {
    return false;
  }
  if (bytes.length === 0 || bytes.length > LIMITS.logoMaxBytes) return false;
  const magic = m[1] === 'png' ? PNG_MAGIC : JPEG_MAGIC;
  return magic.every((b, i) => bytes[i] === b);
}

export const brandingPatchRequestSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(100).nullable().optional(),
  logoData: z
    .string()
    .refine(isValidLogoData, 'logoData must be a PNG or JPEG data URL of at most 200 KiB')
    .nullable()
    .optional(),
  accentColor: hexColorSchema.nullable().optional(),
  supportEmail: emailSchema.nullable().optional(),
});

// ---------- users (6.6) ----------

export const userWithSeatSchema = userSchema.extend({ seat: seatSchema.nullable() });
export const usersPageSchema = pageSchema(userWithSeatSchema);

export const inviteRequestSchema = z.object({
  email: emailSchema,
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .transform((s) => sanitiseText(s, SANITISE_LIMITS.default)),
  role: userRoleSchema,
  tier: packageTierSchema.optional(),
});
export const inviteResponseSchema = z.object({ user: userSchema, inviteUrl: z.string() });

export const roleChangeRequestSchema = z.object({ role: userRoleSchema, tier: packageTierSchema.optional() });
export const statusChangeRequestSchema = z.object({ status: z.enum(['active', 'disabled']) });
