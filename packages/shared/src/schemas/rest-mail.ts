/**
 * Phase F section 4 (docs/specs/phase-f-contracts.md): REST shapes of email invites and password reset. The
 * `inviteRequestSchema.sendEmail` and `inviteResponseSchema.mailed` additions live in `rest-core.ts`.
 */
import { z } from 'zod';
import { isoTimestampSchema, passwordSchema } from './common.js';

/** `GET /api/v1/auth/options` (public, from config only, never per account; section 4.1c). */
export const authOptionsSchema = z.strictObject({ passwordReset: z.boolean(), inviteMail: z.boolean() });
export type AuthOptions = z.infer<typeof authOptionsSchema>;

/** `POST /api/v1/auth/password-reset/request` (always `202 {}`, section 4.3a); bounds as `loginRequestSchema`. */
export const passwordResetRequestSchema = z.strictObject({ email: z.string().min(1).max(254) });
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;

/** A mailed token: 32 CSPRNG bytes, base64url without padding (43 characters). */
export const mailTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'base64url of 32 bytes');

/** `POST /api/v1/auth/password-reset/confirm` (section 4.3e). */
export const passwordResetConfirmSchema = z.strictObject({ token: mailTokenSchema, newPassword: passwordSchema });
export type PasswordResetConfirm = z.infer<typeof passwordResetConfirmSchema>;

/** `POST /api/v1/users/:id/invite/resend` reply (section 4.2c). */
export const inviteResendReplySchema = z.strictObject({
  inviteUrl: z.string().max(2048),
  mailed: z.boolean(),
  inviteExpiresAt: isoTimestampSchema,
});
export type InviteResendReply = z.infer<typeof inviteResendReplySchema>;
