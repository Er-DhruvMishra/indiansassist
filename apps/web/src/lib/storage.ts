/** Storage access that never throws (private mode, disabled storage, sandboxed iframes). */
type Area = 'session' | 'local';

function area(a: Area): Storage | null {
  try {
    return a === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readStore(a: Area, key: string): string | null {
  try {
    return area(a)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStore(a: Area, key: string, value: string): void {
  try {
    area(a)?.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function removeStore(a: Area, key: string): void {
  try {
    area(a)?.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Desk display name typed on the join page (not a contract key; a local convenience only). */
export const JOIN_LABEL_KEY = 'ia.join.label';
