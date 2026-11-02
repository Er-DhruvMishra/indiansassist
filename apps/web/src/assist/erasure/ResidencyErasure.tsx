/**
 * The erasure line of the residency report (docs/specs/phase-f-contracts.md sections 3.2b2, 5.7, stream erasure),
 * rendered by the foundation's `<ResidencyErasureSlot/>` inside the "Audit chain and erasure" list of
 * `ResidencyReportView`. The foundation renders the Phase E line unchanged on screen; in print the line is a
 * full-width box of exactly 12 mm (three 8 pt lines: state, date, note), the budget the residency print measurement
 * counts on. The erasure stream replaces the body (state, scheduled date, note) and keeps the box.
 */
import type { ResidencyReport } from '@indiansassist/shared';
import { Badge } from '../../components/ui';

/** Section 3.2b2: the print budget of the erasure block, appended to `RESIDENCY_PRINT_CSS`. */
export const RESIDENCY_ERASURE_PRINT_CSS = `
@media print {
  .residency-report .rr-grid > div.rr-erasure { grid-column: 1 / -1 !important; height: 12mm !important; overflow: hidden !important; }
  .residency-report .rr-grid > div.rr-erasure, .residency-report .rr-grid > div.rr-erasure * { font-size: 8pt !important; line-height: 4mm !important; }
}
`;

export function ResidencyErasure({ erasure }: { erasure: ResidencyReport['erasure'] }) {
  if (!erasure) return null;
  return (
    <div className="rr-erasure grid grid-cols-1 gap-1 border-b border-slate-100 py-1.5 sm:grid-cols-3 dark:border-slate-800" data-testid="residency-erasure">
      <dt className="text-sm font-medium text-slate-700 dark:text-slate-300">Erasure</dt>
      <dd className="text-sm break-words sm:col-span-2">
        <Badge tone="amber">{erasure.available ? 'Available' : 'Not available'}</Badge> {erasure.note}
      </dd>
    </div>
  );
}
