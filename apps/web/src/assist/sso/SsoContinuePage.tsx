/**
 * /sso/continue (docs/specs/phase-e-contracts.md section 3.4 O1, stream sso): the interstitial a cross-site begin
 * link lands on. The foundation lands this placeholder; the sso stream replaces it with the page that names the org
 * and the IdP and offers a same-origin Continue button.
 */
import { PublicLayout, TextLink } from '../../pages/PublicLayout';
import { usePageTitle } from '../../hooks/usePageTitle';

export function SsoContinuePage() {
  usePageTitle('Continue to sign in');
  return (
    <PublicLayout title="Continue to sign in">
      <p className="mb-3 text-sm">Single sign-on is not available on this server yet.</p>
      <TextLink to="/login">Go to the sign-in page</TextLink>
    </PublicLayout>
  );
}
