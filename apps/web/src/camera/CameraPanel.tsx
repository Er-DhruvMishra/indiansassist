/**
 * The phone camera panel of the console (docs/specs/phase-f-contracts.md section 6.6, stream camera), rendered by the
 * foundation's `<CameraSlot/>` in `LiveConsole` and `AgentConsole`. The foundation lands it empty; the camera stream
 * replaces its body with the link step, the live video, freeze, snapshot and stop.
 */
import type { CameraSlotProps } from '../assist/console/PhaseFSlots';

export function CameraPanel(_props: CameraSlotProps) {
  return null;
}
