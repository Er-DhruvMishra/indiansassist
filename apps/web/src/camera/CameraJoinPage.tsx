/**
 * /c and /c/:code (docs/specs/phase-f-contracts.md section 6.3, stream camera): the phone page that joins a live
 * session as a camera after explicit consent. The foundation lands this placeholder so the routes exist; the camera
 * stream replaces its body. Nothing is captured here.
 */
import { usePageTitle } from '../hooks/usePageTitle';
import { PublicLayout } from '../pages/PublicLayout';

export function CameraJoinPage() {
  usePageTitle('Phone camera');
  return (
    <PublicLayout title="Phone camera">
      <p className="text-sm">Sharing a phone camera is not available on this server yet.</p>
    </PublicLayout>
  );
}
