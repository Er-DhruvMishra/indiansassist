/**
 * /app/settings/integrations (docs/specs/phase-e-contracts.md section 13.4, stream tickets). The foundation lands
 * this placeholder so the route and nav entry exist; the tickets stream replaces its body.
 */
import { Alert, PageHeader } from '../../components/ui';
import { usePageTitle } from '../../hooks/usePageTitle';

export function IntegrationsPage() {
  usePageTitle('Integrations');
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Integrations" />
      <Alert tone="blue">Ticketing integrations are not available on this server yet.</Alert>
    </div>
  );
}
