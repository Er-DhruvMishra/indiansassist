/**
 * The MV3 manifest template (docs/specs/phase-b-contracts.md section 9.1). `scripts/manifest.mjs` calls
 * `buildManifest` at build time with the compiled region origins and writes `dist/manifest.json`. No imports:
 * Node loads this file directly (type stripping).
 */
export type ManifestOptions = {
  version: string;
  regionOrigins: readonly string[];
  devConnectSrc: readonly string[];
  key: string | null;
};

export const PERMISSIONS = ['tabs', 'tabGroups', 'sidePanel', 'storage', 'scripting', 'activeTab', 'offscreen', 'clipboardRead', 'alarms'] as const;
export const OPTIONAL_PERMISSIONS = ['debugger'] as const;

export function extensionPagesCsp(devConnectSrc: readonly string[]): string {
  const connect = ['https:', 'wss:', 'blob:', ...devConnectSrc].join(' ');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src ${connect}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

export function buildManifest(o: ManifestOptions): Record<string, unknown> {
  const matches = o.regionOrigins.map((origin) => `${origin}/*`);
  const manifest: Record<string, unknown> = {
    manifest_version: 3,
    name: 'IndiansAssist',
    version: o.version,
    minimum_chrome_version: '120',
    description: 'Share your browser tabs with your IT technician. Visible, consented, masked by default.',
    icons: { '16': 'icons/16.png', '32': 'icons/32.png', '48': 'icons/48.png', '128': 'icons/128.png' },
    action: { default_title: 'IndiansAssist', default_icon: { '16': 'icons/16.png', '32': 'icons/32.png' } },
    background: { service_worker: 'background.js', type: 'module' },
    side_panel: { default_path: 'sidepanel.html' },
    options_page: 'options.html',
    permissions: [...PERMISSIONS],
    optional_permissions: [...OPTIONAL_PERMISSIONS],
    host_permissions: ['<all_urls>'],
    content_scripts: [{ matches, js: ['bridge.js'], run_at: 'document_idle' }],
    externally_connectable: { matches },
    web_accessible_resources: [],
    content_security_policy: { extension_pages: extensionPagesCsp(o.devConnectSrc) },
    incognito: 'not_allowed',
    storage: { managed_schema: 'managed_schema.json' },
  };
  if (o.key) manifest.key = o.key;
  return manifest;
}
