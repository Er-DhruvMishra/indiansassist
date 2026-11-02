/**
 * Phase F console slots (docs/specs/phase-f-contracts.md sections 1.4, 13.4). The foundation places each slot in the
 * shared console files once; each renders the component its stream supplies (nothing, or today's output, until then),
 * so the streams never edit `LiveConsole`, `AgentConsole`, `AppShell`, `ResidencyPage` or `SharingView` for them.
 */
import type { PackageTier, ResidencyReport, UserRole } from '@indiansassist/shared';
import { CameraPanel } from '../../camera/CameraPanel';
import { ErasureBanner } from '../erasure/ErasureBanner';
import { ResidencyErasure } from '../erasure/ResidencyErasure';
import { KeepState } from './agent/KeepState';

export { CameraLinkAccessory } from '../../camera/CameraLinkAccessory';

/** What the camera panel needs to know about the live session it sits in (section 6). */
export type CameraSlotSession = {
  id: string;
  /** True while the session is live (a camera link needs an `active` session, section 6.2d). */
  live: boolean;
  /** True while this console's own session recording runs: the console records the camera with it (section 6.5a). */
  consoleRecording: boolean;
};

export type CameraSlotProps = { session: CameraSlotSession; sendChat: (text: string) => void; tier: PackageTier };

/**
 * The phone camera panel of a live P1, P3 or P4 session (stream camera, section 6.6). `sendChat` posts the link text
 * through the console's existing chat path (section 6.1 step 2).
 */
export function CameraSlot({ session, sendChat, tier }: CameraSlotProps) {
  return <CameraPanel session={session} sendChat={sendChat} tier={tier} />;
}

/**
 * The Desk user's Keep choice, read-only (stream fixes, section 3.4b): `kept` is the last `ctl.event keep` value the
 * agent sent this session, null when it sent none.
 */
export function DeskKeepSlot({ kept }: { kept: boolean | null }) {
  return <KeepState kept={kept} />;
}

/** The erasure notice every signed-in user of the org sees from the request on (stream erasure, section 5.2d). */
export function ErasureBannerSlot({ role }: { role: UserRole }) {
  return <ErasureBanner role={role} />;
}

/**
 * The erasure line of the residency report (stream erasure, section 5.7). In print it occupies a fixed 12 mm budget
 * (section 3.2b2), so the residency print measurement holds before and after the erasure stream fills it.
 */
export function ResidencyErasureSlot({ erasure }: { erasure: ResidencyReport['erasure'] }) {
  return <ResidencyErasure erasure={erasure} />;
}
