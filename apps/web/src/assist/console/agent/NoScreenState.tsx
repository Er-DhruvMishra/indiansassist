/**
 * The no-screen state of a native Desk that advertises no `screen` feature (docs/specs/phase-e-contracts.md section
 * 7.4, stream linux: a Linux Desk on a Wayland session), rendered by the foundation's `<NoScreenSlot/>` around the
 * screen in `AgentConsole`. When the capabilities are known and lack `screen`, it shows the state in place of the
 * video (the input overlay lives inside the screen, so no input can be sent from here); otherwise, and while the
 * capabilities are not known yet, it renders the screen it wraps unchanged.
 */
import type { ReactNode } from 'react';
import type { AgentCapabilities } from '@indiansassist/shared';

export const NO_SCREEN_TITLE = 'The Desk cannot share its screen: Wayland session';
export const NO_SCREEN_DETAIL = 'Chat, files and playbooks still work. Control and clipboard need a shared screen, so they are not available.';
export const NO_SCREEN_HINT = 'If the sign-in screen of the Desk offers an Xorg (X11) session, the user can sign in to that session to share the screen.';

export function NoScreenState({ capabilities, children }: { capabilities: AgentCapabilities | null | undefined; children: ReactNode }) {
  if (!capabilities || capabilities.features.includes('screen')) return <>{children}</>;
  return (
    <section
      role="status"
      aria-labelledby="no-screen-title"
      data-testid="no-screen-state"
      className="flex min-h-72 flex-col items-center justify-center gap-2 rounded-md bg-slate-950 p-6 text-center text-slate-200"
    >
      <h2 id="no-screen-title" className="text-base font-semibold text-white">
        {NO_SCREEN_TITLE}
      </h2>
      <p className="max-w-prose text-sm">{NO_SCREEN_DETAIL}</p>
      <p className="max-w-prose text-xs text-slate-300">{NO_SCREEN_HINT}</p>
    </section>
  );
}
