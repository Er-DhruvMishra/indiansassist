/**
 * Phase F mail texts (docs/specs/phase-f-contracts.md sections 4.1a, 4.2b, 4.3b, 4.3d, 4.3f). Plain text only, a fixed
 * subject per kind, and every name that comes from a person (display names, org names) passed through `sanitiseText`
 * and stripped of CR and LF, so nothing a user typed can start a new header line or forge a paragraph. A mail never
 * names the requesting IP.
 */
import { sanitiseText, type MailKind, type UserRole } from '@indiansassist/shared';

/** The fixed subject of each kind (rule 4.1a). */
export const MAIL_SUBJECTS: Record<Exclude<MailKind, 'receipt' | 'erasure'>, string> = {
  invite: 'Your invitation to IndiansAssist',
  reset: 'Reset your IndiansAssist password',
  reset_notice: 'Signing in to IndiansAssist',
  break_glass: 'IndiansAssist: break-glass password reset',
};

/** One line of person-supplied text: sanitised, CR / LF / other line breaks folded to spaces, bounded. */
export function oneLine(s: string, limit = 200): string {
  return sanitiseText(s, limit)
    .replace(/[\r\n\u2028\u2029\u0085\v\f]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const ROLE_WORDS: Record<UserRole, string> = {
  technician: 'a technician',
  senior_technician: 'a senior technician',
  org_admin: 'an organisation administrator',
  auditor: 'an auditor',
  observer: 'an observer',
};

/** `2026-11-09 14:05 UTC`: unambiguous for every reader, whatever their locale. */
export function mailDate(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export type MailText = { subject: string; text: string };

/** Rule 4.2b. `ssoBeginUrl` set (an `sso_required` org) replaces the link and the password sentence. */
export function inviteMail(p: {
  inviterName: string;
  orgName: string;
  role: UserRole;
  inviteUrl: string;
  expiresAt: Date;
  ssoBeginUrl: string | null;
}): MailText {
  const head = `${oneLine(p.inviterName)} invited you to ${oneLine(p.orgName)} on IndiansAssist as ${ROLE_WORDS[p.role] ?? 'a member'}.`;
  const body = p.ssoBeginUrl
    ? `Sign in with your organisation's single sign-on: ${p.ssoBeginUrl}`
    : `Open this link to set your name and password: ${p.inviteUrl}\n\nThe link works once and expires on ${mailDate(p.expiresAt)}.`;
  return {
    subject: MAIL_SUBJECTS.invite,
    text: `${head}\n\n${body}\n\nIf you did not expect this invitation, you can ignore this email.\n`,
  };
}

/** Rule 4.3d: the reset link (a fragment, never a query), the org, the expiry; never the requesting IP. */
export function resetMail(p: { orgName: string; resetUrl: string; expiresAt: Date }): MailText {
  return {
    subject: MAIL_SUBJECTS.reset,
    text:
      `Someone asked to reset the password of your IndiansAssist account at ${oneLine(p.orgName)}.\n\n` +
      `Open this link to choose a new password: ${p.resetUrl}\n\n` +
      `The link works once and expires at ${mailDate(p.expiresAt)}. Every device signed in to your account will be signed out.\n\n` +
      'If you did not ask for this, ignore this email; your password is unchanged.\n',
  };
}

/** Rule 4.3b: the SSO notice an SSO user gets instead of a reset link. */
export function ssoNoticeMail(p: { orgName: string; beginUrl: string }): MailText {
  return {
    subject: MAIL_SUBJECTS.reset_notice,
    text:
      `Someone asked to reset the password of your IndiansAssist account at ${oneLine(p.orgName)}.\n\n` +
      `Your organisation signs in with single sign-on, so there is no password to reset. Sign in here: ${p.beginUrl}\n\n` +
      'If you did not ask for this, ignore this email; nothing was changed.\n',
  };
}

/** Rule 4.3f: to every other active org_admin after a break-glass account's password was reset under SSO required. */
export function breakGlassResetMail(p: { name: string; orgName: string; at: Date }): MailText {
  return {
    subject: MAIL_SUBJECTS.break_glass,
    text:
      `${oneLine(p.name)} reset the break-glass password at ${mailDate(p.at)}.\n\n` +
      `Single sign-on is required for ${oneLine(p.orgName)}. Every session of that account was signed out. ` +
      'If this was not expected, review the audit log and the break-glass list in the SSO settings.\n',
  };
}
