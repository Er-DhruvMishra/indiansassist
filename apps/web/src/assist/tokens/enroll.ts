/**
 * Phase D section 13.4 (tokens page) and 12.1 / 12.3: the enrollment carrier for a mass rollout.
 * `GET /devices/enroll-config` (org_admin, section 7.2) mints the signed `enroll.iaconfig`; `IA_ENROLL` is that
 * file's bytes in base64url, and the GPO / Intune snippets below paste exactly that value (packaging/README.md,
 * "Deployment paths"). The call lives here rather than in `lib/fleetApi.ts` so the tokens page owns it.
 */
import { base64urlEncode, utf8Encode, enrollConfigReplySchema, type Token } from '@indiansassist/shared';
import { api } from '../../lib/api';

export const enrollConfigApi = {
  /** `GET /devices/enroll-config?tokenId=&groupId=` (org_admin): the signed `enroll.iaconfig` text. */
  get: (tokenId: string, groupId?: string) =>
    api.get<{ iaconfig: string }>('/devices/enroll-config', {
      schema: enrollConfigReplySchema,
      query: { tokenId, groupId },
    }),
};

/** The `IA_ENROLL` MSI property value: base64url (no padding) of the signed config's bytes (section 12.3). */
export function iaEnrollValue(iaconfig: string): string {
  return base64urlEncode(utf8Encode(iaconfig));
}

/** The base MSI is signed per architecture in CI; its version is not known to the console. */
export const MSI_FILE_NAME = 'IndiansAssist-Agent-<version>-windows-x64.msi';

export const ENROLL_SECRET_TEXT =
  'The enrollment config and the IA_ENROLL value are secrets. Anyone who holds one can enroll devices into this organisation, up to this token’s device limit and until it expires. Keep the file, the transform and any command line that carries it on a share only your deployment accounts can read.';

/** Group Policy: build the org transform from the file, or pass the value on an msiexec startup script. */
export function gpoSnippet(iaEnroll: string, orgName: string): string {
  return [
    '# 1. Build the org transform from the base MSI and the downloaded enroll.iaconfig:',
    `.\\New-EnrollTransform.ps1 -Msi .\\${MSI_FILE_NAME} \``,
    `    -EnrollConfig .\\enroll.iaconfig -OrgName "${orgName}" -Out .\\enroll.mst`,
    '# 2. Copy the MSI and the MST to a share Domain Computers can read, then add the package under',
    '#    Computer Configuration > Policies > Software Settings > Software installation',
    '#    (New > Package > Advanced > Modifications tab). Use computer assignment, not user assignment.',
    '',
    '# Startup-script alternative (no transform, the property carries the same signed config):',
    `msiexec /i \\\\server\\share\\${MSI_FILE_NAME} IA_ENROLL=${iaEnroll} /qn /norestart`,
  ].join('\n');
}

/** Intune: the install command line of a Win32 / line-of-business app, install context Device. */
export function intuneSnippet(iaEnroll: string): string {
  return [
    '# Install command (install context: Device; assign the app to a device group):',
    `msiexec /i ${MSI_FILE_NAME} IA_ENROLL=${iaEnroll} /qn /norestart`,
    '# Uninstall command:',
    'msiexec /x {ProductCode} /qn',
    '# Detection: the MSI product code, or the IndiansAssistAgent service.',
  ].join('\n');
}

export type EnrollmentUsage = {
  enrolled: number;
  max: number;
  remaining: number;
  /** The token has minted every device identity it may (the server also flips its status to `used`). */
  full: boolean;
  /** 80 % or more of the limit is spent: the next rollout wave needs a new token and transform (section 12.1). */
  nearLimit: boolean;
};

/** `devicesEnrolled / maxDevices` of an enrollment token; both are optional on the wire (section 2.1). */
export function enrollmentUsage(t: Pick<Token, 'devicesEnrolled' | 'maxDevices'>): EnrollmentUsage {
  const max = Math.max(1, t.maxDevices ?? 1);
  const enrolled = t.devicesEnrolled ?? 0;
  const remaining = Math.max(0, max - enrolled);
  return { enrolled, max, remaining, full: remaining === 0, nearLimit: remaining > 0 && enrolled / max >= 0.8 };
}

/** A staged rollout should be warned before the token dies: 72 h (the default lifetime is 7 days). */
export const NEAR_EXPIRY_MS = 72 * 3_600_000;

export function nearExpiry(expiresAt: string, now: number = Date.now()): boolean {
  const left = Date.parse(expiresAt) - now;
  return Number.isFinite(left) && left > 0 && left <= NEAR_EXPIRY_MS;
}
