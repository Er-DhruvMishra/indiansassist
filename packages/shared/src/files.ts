/** File transfer helpers shared by Assist and Desk (contracts section 8.3 F6). */

/** Extensions that can run programs; the accept dialog warns and needs a second click. */
export const EXECUTABLE_EXTENSIONS = [
  'exe',
  'com',
  'scr',
  'bat',
  'cmd',
  'ps1',
  'psm1',
  'vbs',
  'vbe',
  'js',
  'jse',
  'wsf',
  'wsh',
  'msi',
  'msp',
  'msc',
  'dll',
  'hta',
  'cpl',
  'jar',
  'reg',
  'lnk',
  'app',
  'pkg',
  'dmg',
  'sh',
  'command',
  'apk',
  // Phase C section 6.1 F4 additions (A F6 amended).
  'pif',
  'application',
  'gadget',
  'inf',
  'ins',
  'isp',
  'msh',
  'msh1',
  'msh2',
  'mshxml',
  'msh1xml',
  'msh2xml',
  'ps1xml',
  'psd1',
  'psc1',
  'appref-ms',
  'diagcab',
] as const;

/**
 * Phase C section 6.1 F4: formats that act when Explorer merely draws the folder (icon / UNC fetches leak NTLM);
 * the native Desk refuses them with `file.reject { reason: 'bad_name' }` and the console greys sending them.
 */
export const PASSIVE_RISK_EXTENSIONS = [
  'url',
  'scf',
  'library-ms',
  'settingcontent-ms',
  'website',
  'theme',
  'deskthemepack',
  'searchconnector-ms',
] as const;

/** Phase C section 6.1 F3: a leaf whose stem before the first dot is one of these is `bad_name` on a native Desk. */
export const RESERVED_DEVICE_STEMS = [
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
] as readonly string[];

/** Last suffix of a file name, lower-cased, without the dot; null when there is none ("none" in the dialog). */
export function fileExtension(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

export function isExecutableName(name: string): boolean {
  const ext = fileExtension(name);
  return ext !== null && (EXECUTABLE_EXTENSIONS as readonly string[]).includes(ext);
}

/** Number of 16 KiB chunks for a file of `size` bytes. */
export function chunkCount(size: number, chunkSize = 16384): number {
  return Math.ceil(size / chunkSize);
}

export function isPassiveRiskName(name: string): boolean {
  const ext = fileExtension(name);
  return ext !== null && (PASSIVE_RISK_EXTENSIONS as readonly string[]).includes(ext);
}

/** Stem before the first dot of the last path segment, case-insensitive (`con.txt`, `AUX.log`). */
export function hasReservedDeviceStem(name: string): boolean {
  const leaf = name.split(/[/\\]/).pop() ?? '';
  return RESERVED_DEVICE_STEMS.includes((leaf.split('.')[0] ?? '').toLowerCase());
}
