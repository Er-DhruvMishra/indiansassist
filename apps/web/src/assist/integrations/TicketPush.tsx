/**
 * The ticket push dialog and push list of an ended session (docs/specs/phase-e-contracts.md section 13.4, stream
 * tickets), rendered by the foundation's `<TicketPushSlot/>` in `EndedView`. Renders nothing until the tickets stream
 * supplies it.
 */
import type { SessionDetail } from '@indiansassist/shared';

export function TicketPush(_props: { session: SessionDetail }) {
  return null;
}
