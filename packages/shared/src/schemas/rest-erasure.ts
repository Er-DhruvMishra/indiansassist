/**
 * Phase F section 5.6 (docs/specs/phase-f-contracts.md): REST shapes of org erasure. Names are display names (they
 * read "Erased user" after completion); the certificate and the chain digest are public by unguessable id.
 */
import { z } from 'zod';
import { ERASURE_STATES, LIMITS } from '../enums.js';
import { hex64Schema, isoTimestampSchema, slugSchema, uuidSchema } from './common.js';

const person = z.strictObject({ id: uuidSchema, name: z.string().max(200) });

/** `OrgErasure` (section 5.6). `certificateUrl` is set from the request on; it answers `404` until completion. */
export const orgErasureSchema = z.strictObject({
  id: uuidSchema,
  state: z.enum(ERASURE_STATES),
  requestedBy: person,
  requestedAt: isoTimestampSchema,
  approvedBy: person.nullable(),
  approvedAt: isoTimestampSchema.nullable(),
  coolingOffUntil: isoTimestampSchema.nullable(),
  cancelledBy: person.nullable(),
  cancelledAt: isoTimestampSchema.nullable(),
  executedAt: isoTimestampSchema.nullable(),
  completedAt: isoTimestampSchema.nullable(),
  certificateUrl: z.string().max(2048).nullable(),
});
export type OrgErasure = z.infer<typeof orgErasureSchema>;

/** The banner's input for every role (section 5.6): no names. */
export const erasureNoticeSchema = z.strictObject({
  state: z.enum(ERASURE_STATES),
  coolingOffUntil: isoTimestampSchema.nullable(),
  certificateUrl: z.string().max(2048).nullable(),
});
export type ErasureNotice = z.infer<typeof erasureNoticeSchema>;

/**
 * `GET /api/v1/orgs/current/erasure`: `{ erasure }` (the open one, else the latest terminal one) for org_admin and
 * auditor, `{ notice }` for every other role.
 */
export const erasureStatusReplySchema = z.union([
  z.strictObject({ erasure: orgErasureSchema.nullable() }),
  z.strictObject({ notice: erasureNoticeSchema.nullable() }),
]);
export type ErasureStatusReply = z.infer<typeof erasureStatusReplySchema>;

/** `POST /api/v1/orgs/current/erasure` (section 5.6); the reason is stored in the row, never chained. */
export const erasureRequestSchema = z.strictObject({
  confirmSlug: slugSchema,
  reason: z.string().max(LIMITS.reasonMax).optional(),
  solo: z.boolean().optional(),
});
export type ErasureRequest = z.infer<typeof erasureRequestSchema>;

/** `POST /api/v1/orgs/current/erasure/:id/approve`. */
export const erasureApproveSchema = z.strictObject({ confirmSlug: slugSchema });
export type ErasureApprove = z.infer<typeof erasureApproveSchema>;

/** `POST /api/v1/orgs/current/erasure/:id/confirm` (solo path, section 5.2f): the token from the link fragment. */
export const erasureConfirmSchema = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'base64url of 32 bytes') });
export type ErasureConfirm = z.infer<typeof erasureConfirmSchema>;

/** Reply of request, confirm, approve and cancel; `confirmUrl` only for a solo request under the `log` driver. */
export const erasureReplySchema = z.strictObject({ erasure: orgErasureSchema, confirmUrl: z.string().max(2048).optional() });
export type ErasureReply = z.infer<typeof erasureReplySchema>;

/** `GET /api/v1/erasures/:id/chain-digest?after=&limit=` query. */
export const chainDigestQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(10_000).optional(),
});
export type ChainDigestQuery = z.infer<typeof chainDigestQuerySchema>;

/** One page of the chain digest: no material, action or label. */
export const chainDigestPageSchema = z.strictObject({
  items: z.array(z.strictObject({ seq: z.number().int().min(1), hash: hex64Schema, prevHash: hex64Schema })).max(10_000),
  nextAfter: z.number().int().min(0).nullable(),
});
export type ChainDigestPage = z.infer<typeof chainDigestPageSchema>;
