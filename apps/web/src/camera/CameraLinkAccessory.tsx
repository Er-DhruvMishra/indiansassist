/**
 * The QR code beside a chat message that holds exactly one `${WEB_ORIGIN}/c/<code>` link (docs/specs/phase-f-contracts.md
 * section 6.1 step 2, stream camera), passed to the P1 room's `ChatPanel` as `messageAccessory` by `SharingView`: the
 * Desk person scans it from their screen with the phone. Any other message (no link, two links, another origin, a
 * malformed code) draws nothing.
 */
import { CAMERA_CODE_RE } from '@indiansassist/shared';
import { QrCode } from '../components/QrCode';
import type { ChatItem } from '../lib/link';

const LINK_RE = /https?:\/\/[^\s/]+\/c\/[^\s)]+/g;

/** The camera link of a chat text, or null unless it holds exactly one valid link on this web origin. */
export function cameraLinkIn(text: string, origin: string): string | null {
  const found = text.match(LINK_RE) ?? [];
  if (found.length !== 1) return null;
  const url = found[0]!;
  const prefix = `${origin}/c/`;
  if (!url.startsWith(prefix)) return null;
  return CAMERA_CODE_RE.test(url.slice(prefix.length)) ? url : null;
}

export function CameraLinkAccessory({ message }: { message: ChatItem }) {
  if (message.mine) return null;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const url = cameraLinkIn(message.text, origin);
  if (!url) return null;
  return (
    <span className="mt-2 flex flex-col items-start gap-1">
      <QrCode
        text={url}
        label="QR code: scan it with your phone to show the technician your phone's camera"
        size={144}
      />
      <span className="text-xs">Scan with your phone's camera app, or open the link on your phone.</span>
    </span>
  );
}
