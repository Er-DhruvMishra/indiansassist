/**
 * /app/settings/ai (docs/specs/phase-e-contracts.md section 13.4, stream ai). The foundation lands this placeholder
 * so the route and nav entry exist; the ai stream replaces its body with the AI policy page.
 */
import { Alert, PageHeader } from '../../components/ui';
import { usePageTitle } from '../../hooks/usePageTitle';

export function AiPolicyPage() {
  usePageTitle('AI summaries');
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="AI summaries" />
      <Alert tone="blue">AI session summaries are not available on this server yet.</Alert>
    </div>
  );
}
