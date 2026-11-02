/**
 * /reset (docs/specs/phase-f-contracts.md section 4.4, stream mail): the password-reset request and confirm page. The
 * foundation lands this placeholder so the route exists; the mail stream replaces its body.
 */
import { usePageTitle } from '../hooks/usePageTitle';
import { PublicLayout, TextLink } from './PublicLayout';

export function PasswordResetPage() {
  usePageTitle('Reset your password');
  return (
    <PublicLayout title="Reset your password">
      <div className="flex flex-col gap-4">
        <p className="text-sm">Password reset is not available on this server yet. Ask an administrator of your organisation.</p>
        <TextLink to="/login">Go to the sign-in page</TextLink>
      </div>
    </PublicLayout>
  );
}
