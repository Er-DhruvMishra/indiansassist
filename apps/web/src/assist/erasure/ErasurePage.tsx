/**
 * /app/settings/erasure (docs/specs/phase-f-contracts.md sections 5.6, 13.4, stream erasure). The foundation lands this
 * placeholder so the route and nav entry exist; the erasure stream replaces its body with the erasure page.
 */
import { Alert, PageHeader } from '../../components/ui';
import { usePageTitle } from '../../hooks/usePageTitle';

export function ErasurePage() {
  usePageTitle('Organisation erasure');
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Organisation erasure" />
      <Alert tone="blue">Organisation erasure is not available on this server yet.</Alert>
    </div>
  );
}
