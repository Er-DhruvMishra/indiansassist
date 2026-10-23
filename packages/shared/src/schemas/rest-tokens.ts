/** REST schemas: tokens and public lookup (contracts 3.2, 6.7). */
import { z } from 'zod';
import { TOKEN_LIFETIMES, type PackageTier, type TokenType } from '../enums.js';
import { sanitiseText, SANITISE_LIMITS } from '../audit/sanitise.js';
import {
  hexColorSchema,
  isoTimestampSchema,
  packageTierSchema,
  regionSchema,
  tokenStatusSchema,
  tokenTypeSchema,
  userRefSchema,
  uuidSchema,
} from './common.js';
import { pageSchema } from './rest-core.js';

/**
 * POST /api/v1/tokens body. Refinement (section 3.2): `ttlMinutes` only with one_time / timed,
 * `ttlDays` only with enrollment, never both, never above the maximum. `label` is sanitised (max 80).
 * The tier / typ rule (enrollment only on p4_installed) answers `invalid_token_type`, not
 * `validation_failed`, so it is a separate check: `tokenTypeAllowedForTier`.
 */
export const createTokenRequestSchema = z
  .object({
    tier: packageTierSchema,
    typ: tokenTypeSchema,
    ttlMinutes: z.number().int().min(1).optional(),
    ttlDays: z.number().int().min(1).optional(),
    label: z
      .string()
      .max(1000)
      .transform((s) => sanitiseText(s, SANITISE_LIMITS.label))
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.ttlMinutes !== undefined && v.ttlDays !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'give ttlMinutes or ttlDays, not both', path: ['ttlDays'] });
      return;
    }
    if (v.typ === 'enrollment') {
      if (v.ttlMinutes !== undefined)
        ctx.addIssue({ code: 'custom', message: 'ttlMinutes is not allowed with enrollment', path: ['ttlMinutes'] });
      if (v.ttlDays !== undefined && v.ttlDays > TOKEN_LIFETIMES.enrollment.maxDays)
        ctx.addIssue({
          code: 'custom',
          message: `ttlDays must be <= ${TOKEN_LIFETIMES.enrollment.maxDays}`,
          path: ['ttlDays'],
        });
    } else {
      if (v.ttlDays !== undefined)
        ctx.addIssue({ code: 'custom', message: `ttlDays is not allowed with ${v.typ}`, path: ['ttlDays'] });
      const max = TOKEN_LIFETIMES[v.typ].maxMin;
      if (v.ttlMinutes !== undefined && v.ttlMinutes > max)
        ctx.addIssue({ code: 'custom', message: `ttlMinutes must be <= ${max}`, path: ['ttlMinutes'] });
    }
  });

export type CreateTokenRequest = z.output<typeof createTokenRequestSchema>;

/** Token lifetime in seconds for a validated create request (defaults from TOKEN_LIFETIMES). */
export function tokenLifetimeSeconds(req: Pick<CreateTokenRequest, 'typ' | 'ttlMinutes' | 'ttlDays'>): number {
  if (req.typ === 'enrollment') return (req.ttlDays ?? TOKEN_LIFETIMES.enrollment.defaultDays) * 86400;
  return (req.ttlMinutes ?? TOKEN_LIFETIMES[req.typ].defaultMin) * 60;
}

/** `typ = enrollment` is allowed only for `p4_installed` (section 3.2); otherwise `400 invalid_token_type`. */
export function tokenTypeAllowedForTier(typ: TokenType, tier: PackageTier): boolean {
  return typ !== 'enrollment' || tier === 'p4_installed';
}

export const tokenSchema = z.object({
  id: uuidSchema,
  tier: packageTierSchema,
  typ: tokenTypeSchema,
  status: tokenStatusSchema,
  shortCode: z.string().regex(/^\d{12}$/),
  shortCodeDisplay: z.string().regex(/^\d{4} \d{4} \d{4}$/),
  label: z.string().nullable(),
  region: regionSchema,
  createdBy: userRefSchema,
  issuedAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
  usedAt: isoTimestampSchema.nullable(),
  revokedAt: isoTimestampSchema.nullable(),
  deniedCount: z.number().int().nonnegative(),
  joinUrl: z.string(),
  joinHost: z.string(),
});

export const tokensPageSchema = pageSchema(tokenSchema);

export const tokensListQuerySchema = z.object({
  status: tokenStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

export const createTokenResponseSchema = z.object({
  token: tokenSchema,
  compact: z.string().startsWith('ia1.'),
  joinUrl: z.string(),
});

export const publicLookupRequestSchema = z.object({ code: z.string().min(1).max(4096) });

export const publicTokenSchema = z.object({
  tokenId: uuidSchema,
  tier: packageTierSchema,
  typ: tokenTypeSchema,
  expiresAt: isoTimestampSchema,
  region: regionSchema,
  org: z.object({
    displayName: z.string(),
    logoData: z.string().nullable(),
    accentColor: hexColorSchema.nullable(),
    supportEmail: z.string().nullable(),
  }),
  technician: z.object({ name: z.string() }).nullable(),
  signalUrl: z.string(),
  joinSupported: z.boolean(),
  /**
   * Extension install info (Phase B 11.3): non-null only for `p2_extension`. The api always sends the key; it is
   * optional in the schema so Phase A fixtures still parse.
   */
  extension: z
    .object({
      ids: z.array(z.string()),
      webStoreUrl: z.string().nullable(),
      edgeAddonsUrl: z.string().nullable(),
      minVersion: z.string(),
    })
    .nullable()
    .optional(),
});
