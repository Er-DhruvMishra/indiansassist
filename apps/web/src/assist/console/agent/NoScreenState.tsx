/**
 * The no-screen state of a native Desk that advertises no `screen` feature (docs/specs/phase-e-contracts.md section
 * 7.4, stream linux: a Wayland session), rendered by the foundation's `<NoScreenSlot/>` around the screen in
 * `AgentConsole`. Until the linux stream supplies it, it adds nothing and renders the screen it wraps unchanged.
 */
import type { ReactNode } from 'react';
import type { AgentCapabilities } from '@indiansassist/shared';

export function NoScreenState({ children }: { capabilities: AgentCapabilities | null | undefined; children: ReactNode }) {
  return <>{children}</>;
}
