/**
 * The erasure line of the residency report (docs/specs/phase-f-contracts.md sections 3.2b2, 5.7, stream erasure),
 * rendered by the foundation's `<ResidencyErasureSlot/>` inside the "Audit chain and erasure" list of
 * `ResidencyReportView`. On screen: available or not, the state of an open erasure and its date, and the note. In
 * print the line is a full-width box of exactly 12 mm, the budget the residency print measurement counts on: one 8 pt
 * line for the state and date, and the note set at 6.5 pt in at most two lines (the note of 5.7 is 308 characters;
 * the full text stays in the signed JSON). An older server's `{ available: false, note }` renders as before.
 */
import type { ResidencyReport } from '@indiansassist/shared';
import { Badge } from '../../components/ui';

/** Section 3.2b2: the print budget of the erasure block, appended to `RESIDENCY_PRINT_CSS`. */
export const RESIDENCY_ERASURE_PRINT_CSS = `
@media print {
  .residency-report .rr-grid > div.rr-erasure { grid-column: 1 / -1 !important; height: 12mm !important; overflow: hidden !important; }
  .residency-report .rr-grid > div.rr-erasure, .residency-report .rr-grid > div.rr-erasure * { font-size: 8pt !important; line-height: 4mm !important; }
  .residency-report .rr-grid > div.rr-erasure .rr-erasure-note { display: block !important; font-size: 6.5pt !important; line-height: 3.2mm !important; max-height: 6.4mm !important; overflow: hidden !important; }
}
`;

const STATE_WORDS: Record<string, string> = {
  none: 'no erasure is open',
  pending_confirmation: 'requested by the only administrator; waiting for the mailed confirmation',
  pending_approval: "requested; waiting for a second administrator's approval",
  cooling_off: 'approved and scheduled',
  executing: 'running',
  completed: 'completed',
  cancelled: 'no erasure is open',
  expired: 'no erasure is open',
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
}

export function ResidencyErasure({ erasure }: { erasure: ResidencyReport['erasure'] }) {
  if (!erasure) return null;
  if (!erasure.available)
    return (
      <div className="rr-erasure grid grid-cols-1 gap-1 border-b border-slate-100 py-1.5 sm:grid-cols-3 dark:border-slate-800" data-testid="residency-erasure">
        <dt className="text-sm font-medium text-slate-700 dark:text-slate-300">Erasure</dt>
        <dd className="text-sm break-words sm:col-span-2">
          <Badge tone="amber">Not available</Badge> {erasure.note}
        </dd>
      </div>
    );
  const state = erasure.state ?? 'none';
  const words = STATE_WORDS[state] ?? state;
  return (
    <div className="rr-erasure grid grid-cols-1 gap-1 border-b border-slate-100 py-1.5 sm:grid-cols-3 dark:border-slate-800" data-testid="residency-erasure" data-state={state}>
      <dt className="text-sm font-medium text-slate-700 dark:text-slate-300">Erasure</dt>
      <dd className="text-sm break-words sm:col-span-2">
        <span className="rr-erasure-state">
          <Badge tone={state === 'none' || state === 'cancelled' || state === 'expired' ? 'neutral' : 'red'}>Available</Badge> {words}
          {erasure.scheduledFor ? `, for ${fmtDate(erasure.scheduledFor)}` : ''}.
        </span>{' '}
        <span className="rr-erasure-note text-slate-700 dark:text-slate-300">{erasure.note}</span>
      </dd>
    </div>
  );
}
