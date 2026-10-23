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
] as const;

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
