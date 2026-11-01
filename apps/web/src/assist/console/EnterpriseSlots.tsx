/**
 * Phase E console slots (docs/specs/phase-e-contracts.md sections 1.4, 13.4). The foundation places each slot in the
 * shared console files once; each renders the component its stream supplies (nothing until then), so the streams
 * never edit `EndedView`, `LiveConsole` or `AgentConsole` again.
 */
import type { ReactNode } from 'react';
import type { AgentCapabilities, SessionDetail } from '@indiansassist/shared';
import { TicketPush } from '../integrations/TicketPush';
import { SummaryPanel } from '../summary/SummaryPanel';
import { NoScreenState } from './agent/NoScreenState';

export { useEnterpriseLiveHooks, type EnterpriseLiveSession } from '../summary/useEnterpriseLiveHooks';

/** The AI summary of an ended session (stream ai). */
export function SummaryPanelSlot({ session }: { session: SessionDetail }) {
  return <SummaryPanel session={session} />;
}

/** The ticket push of an ended session (stream tickets). */
export function TicketPushSlot({ session }: { session: SessionDetail }) {
  return <TicketPush session={session} />;
}

/** Wraps the screen of a native Desk; the linux stream shows its no-screen state in place of it (section 7.4). */
export function NoScreenSlot({ capabilities, children }: { capabilities: AgentCapabilities | null | undefined; children: ReactNode }) {
  return <NoScreenState capabilities={capabilities}>{children}</NoScreenState>;
}
