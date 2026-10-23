/**
 * `desk.hello.client` (section 2.4): low-entropy `navigator.userAgentData` only (brands and platform; high-entropy
 * values are never requested), every string within `LIMITS.deskClientStringMax`.
 */
import { LIMITS, type DeskBrowser, type DeskOs } from '@indiansassist/shared';
import { EXTENSION_VERSION } from '../shared/constants';

type UaData = { brands?: { brand: string; version: string }[]; platform?: string };

export type DeskClient = { kind: 'extension'; version: string; browser: { name: DeskBrowser; version: string }; os: DeskOs };

export function deskClient(uaData: UaData | undefined = (globalThis.navigator as { userAgentData?: UaData } | undefined)?.userAgentData): DeskClient {
  const brands = uaData?.brands ?? [];
  const edge = brands.find((b) => /Microsoft Edge/i.test(b.brand));
  const chrome = brands.find((b) => /^Google Chrome$/i.test(b.brand)) ?? brands.find((b) => /^Chromium$/i.test(b.brand));
  const pick = edge ?? chrome;
  const name: DeskBrowser = edge ? 'edge' : chrome ? 'chrome' : 'other';
  const version = (pick?.version ?? '0').split('.')[0]!.replace(/\D/g, '').slice(0, LIMITS.browserVersionMax) || '0';
  const p = (uaData?.platform ?? '').toLowerCase();
  const os: DeskOs = p.includes('win') ? 'windows' : p.includes('mac') ? 'mac' : p.includes('chrome os') || p.includes('chromeos') ? 'cros' : p.includes('linux') ? 'linux' : 'other';
  return { kind: 'extension', version: EXTENSION_VERSION.slice(0, LIMITS.deskClientStringMax), browser: { name, version }, os };
}
