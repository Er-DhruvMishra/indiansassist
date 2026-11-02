/**
 * The QR code beside a chat message that holds exactly one `${WEB_ORIGIN}/c/<code>` link (docs/specs/phase-f-contracts.md
 * section 6.1 step 2, stream camera), passed to the P1 room's `ChatPanel` as `messageAccessory` by `SharingView`. The
 * foundation lands it empty (no accessory); the camera stream draws the QR.
 */
import type { ChatItem } from '../lib/link';

export function CameraLinkAccessory(_props: { message: ChatItem }) {
  return null;
}
