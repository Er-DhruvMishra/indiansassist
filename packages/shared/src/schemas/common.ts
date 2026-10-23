/** Shared zod building blocks for REST, signaling, data channel and audit schemas. */
import { z } from 'zod';
import { REGIONS } from '../regions.js';
import {
  ACTOR_TYPES,
  CONSENT_STATES,
  CONSENT_SURFACES,
  FILE_DIRECTIONS,
  LIMITS,
  PACKAGE_TIERS,
  RECORDING_STATUSES,
  SESSION_END_REASONS,
  SESSION_PATHS,
  SESSION_STATES,
  SIDES,
  TOKEN_STATUSES,
  TOKEN_TYPES,
  USER_ROLES,
  USER_STATUSES,
  VERIFY_FAILURE_KINDS,
  PARTICIPANT_ROLES,
} from '../enums.js';

/** Lower-case UUID (any version; desk_ref and connection ids are UUIDs too). */
export const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'expected a lower-case UUID');

/** ISO 8601 UTC with exactly three fractional digits and `Z` (REST and WS time fields, audit `ts`). */
export const isoTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'expected ISO 8601 UTC with milliseconds')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date');

/** Lenient ISO 8601 datetime accepted in query filters (`from` / `to`) and export bodies. */
export const isoDateTimeInputSchema = z.iso.datetime({ offset: true });

/** `ts` of WS and data channel messages: integer milliseconds since the epoch. */
export const epochMsSchema = z.number().int().nonnegative();

export const hex64Schema = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lower-case hex chars');
export const kidSchema = z.string().regex(/^[0-9a-f]{16}$/, 'expected 16 lower-case hex chars');
export const base64urlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, 'expected base64url without padding');
export const shortCodeSchema = z.string().regex(/^[1-9]\d{11}$/, 'expected 12 digits');
export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb');
export const emailSchema = z.email().max(254);
export const passwordSchema = z.string().min(LIMITS.passwordMin).max(LIMITS.passwordMax);
export const slugSchema = z.string().regex(/^[a-z0-9-]{3,40}$/, 'slug must match ^[a-z0-9-]{3,40}$');
export const safeIntSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const uint32Schema = z.number().int().min(0).max(0xffffffff);

export const regionSchema = z.enum(REGIONS);
export const packageTierSchema = z.enum(PACKAGE_TIERS);
export const userRoleSchema = z.enum(USER_ROLES);
export const userStatusSchema = z.enum(USER_STATUSES);
export const tokenTypeSchema = z.enum(TOKEN_TYPES);
export const tokenStatusSchema = z.enum(TOKEN_STATUSES);
export const sessionStateSchema = z.enum(SESSION_STATES);
export const consentStateSchema = z.enum(CONSENT_STATES);
export const consentSurfaceSchema = z.enum(CONSENT_SURFACES);
export const sessionPathSchema = z.enum(SESSION_PATHS);
export const sessionEndReasonSchema = z.enum(SESSION_END_REASONS);
export const participantRoleSchema = z.enum(PARTICIPANT_ROLES);
export const actorTypeSchema = z.enum(ACTOR_TYPES);
export const recordingStatusSchema = z.enum(RECORDING_STATUSES);
export const fileDirectionSchema = z.enum(FILE_DIRECTIONS);
export const sideSchema = z.enum(SIDES);
export const verifyFailureKindSchema = z.enum(VERIFY_FAILURE_KINDS);

/** Any JSON value (used for opaque `data` / `lastStats` on the wire). */
export type JsonLike = string | number | boolean | null | JsonLike[] | { [k: string]: JsonLike };
export const jsonValueSchema: z.ZodType<JsonLike> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

/** `{ id, name }` references (createdBy, assist, acceptedBy). */
export const userRefSchema = z.object({ id: uuidSchema, name: z.string() });

export const verifyFailureSchema = z.object({ kind: verifyFailureKindSchema, seq: z.number().int() });

/** RTCIceServer as sent by the API (section 6.11). */
export const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});

/** `{ iceServers, iceTtl, iceExpiresAt }` (GET /ice and the ICE fields of WS messages). */
export const iceConfigSchema = z.object({
  iceServers: z.array(iceServerSchema),
  iceTtl: z.number().int().positive(),
  iceExpiresAt: isoTimestampSchema,
});

/** Org branding as shown to the Desk (`desk.hello.ok`, `session.created`). */
export const brandingPublicSchema = z.object({
  displayName: z.string(),
  accentColor: hexColorSchema.nullable(),
  logoData: z.string().nullable(),
});
