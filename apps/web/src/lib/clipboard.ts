/** Clipboard write with a legacy fallback. Returns false instead of throwing (section 6.13: best effort). */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clip = (globalThis.navigator as Navigator | undefined)?.clipboard as Clipboard | undefined;
    if (clip && typeof clip.writeText === 'function') {
      await clip.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
