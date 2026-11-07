// Where the shell halves of the Linux release scripts run: through wsl.exe on a Windows build machine, or directly
// with bash on a Linux host (the GitHub Actions ubuntu runner, .github/workflows/release.yml). Pure helpers.

/** `C:\a\b` -> `/mnt/c/a/b` (the WSL view of a Windows path). */
export function toWslPath(winPath) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) throw new Error(`not an absolute Windows path: ${winPath}`);
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`.replace(/\/+$/, '');
}

/** A host path as the shell half sees it: translated into WSL on Windows, unchanged on Linux. */
export function hostPath(platform, p) {
  return platform === 'win32' ? toWslPath(p) : p;
}

/** The command that runs `bash <script> <args>` on this host. */
export function shellCommand(platform, distro, script, args) {
  if (platform === 'win32') return { cmd: 'wsl.exe', args: ['-d', distro, '--', 'bash', toWslPath(script), ...args] };
  if (platform === 'linux') return { cmd: 'bash', args: [script, ...args] };
  throw new Error(`the Linux release scripts run on Windows (through WSL) or on Linux, not on ${platform}`);
}
