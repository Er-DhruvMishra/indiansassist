/**
 * /app/settings/sso (docs/specs/phase-e-contracts.md section 13.4, stream sso). The foundation lands this placeholder
 * so the route and nav entry exist; the sso stream replaces its body with the settings page.
 */
import { Alert, PageHeader } from '../../components/ui';
import { usePageTitle } from '../../hooks/usePageTitle';

export function SsoSettingsPage() {
  usePageTitle('Single sign-on');
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Single sign-on" />
      <Alert tone="blue">Single sign-on is not available on this server yet.</Alert>
    </div>
  );
}
