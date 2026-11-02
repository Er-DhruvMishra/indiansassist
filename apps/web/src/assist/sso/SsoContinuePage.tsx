/**
 * /sso/continue (docs/specs/phase-e-contracts.md section 3.4 O1, stream sso): the interstitial a cross-site begin link
 * lands on. It names the org and the IdP from `GET /auth/sso/:orgSlug/info`, and its Continue button is a same-origin
 * navigation back to the begin route, so a link on another site cannot start a sign-in into an org the user did not
 * read and choose.
 */
import { useSearchParams } from 'react-router';
import { Alert, Spinner } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { usePageTitle } from '../../hooks/usePageTitle';
import { isApiError } from '../../lib/api';
import { PublicLayout, TextLink } from '../../pages/PublicLayout';
import { SsoContinueLink } from './SsoContinueLink';
import { beginHref, beginPathFor, ssoApi } from './ssoApi';

const SLUG_RE = /^[a-z0-9-]{3,40}$/;

export function SsoContinuePage() {
  usePageTitle('Continue to sign in');
  const [params] = useSearchParams();
  const slug = params.get('org') ?? '';
  const valid = SLUG_RE.test(slug);
  const info = useAsync(async () => (valid ? ssoApi.info(slug) : null), [slug, valid]);
  const href = valid
    ? beginHref(
        beginPathFor(slug, {
          loginHint: params.get('login_hint'),
          returnTo: params.get('return_to'),
          test: params.get('test'),
        }),
      )
    : null;

  return (
    <PublicLayout title="Continue to sign in">
      <div className="flex flex-col gap-4">
        {!valid && <Alert>This sign-in link is not complete.</Alert>}
        {valid && info.loading && <Spinner label="Loading the organisation" />}
        {valid && !info.loading && (info.error || !info.data) && (
          <Alert>{isApiError(info.error, 'not_found') ? 'This organisation does not use single sign-on on this server.' : 'The organisation could not be loaded.'}</Alert>
        )}
        {info.data && href && (
          <>
            <p className="text-base">
              Continue to <strong>{info.data.displayName}</strong> to sign in to <strong>{info.data.orgName}</strong>?
            </p>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Only continue if you meant to sign in to this organisation. A link on another website can bring you here.
            </p>
            <SsoContinueLink href={href} label={`Continue to ${info.data.displayName}`} />
          </>
        )}
        <TextLink to="/login">Go to the sign-in page</TextLink>
      </div>
    </PublicLayout>
  );
}
