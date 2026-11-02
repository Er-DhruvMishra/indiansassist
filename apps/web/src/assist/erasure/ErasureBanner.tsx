/**
 * The erasure banner (docs/specs/phase-f-contracts.md section 5.2d, stream erasure), rendered by the foundation's
 * `<ErasureBannerSlot/>` in `AppShell` for every signed-in user. The foundation lands it empty; the erasure stream
 * fills it from the notice of `GET /orgs/current/erasure` (Cancel for org_admins).
 */
import type { UserRole } from '@indiansassist/shared';

export function ErasureBanner(_props: { role: UserRole }) {
  return null;
}
