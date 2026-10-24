/**
 * Throwaway manifest key for the e2e build: an RSA public key (SPKI DER, base64) whose sha256 gives the extension
 * id Chrome assigns to the unpacked build (first 16 bytes, hex digits 0-f mapped to a-p). Generated once per run
 * in the Playwright main process and passed on through `IA_E2E_EXTENSION_KEY`, which the global setup and the
 * workers inherit, so every process agrees on the id.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';

const ENV = 'IA_E2E_EXTENSION_KEY';

export function extensionIdFromKey(keyB64: string): string {
  const hex = createHash('sha256').update(Buffer.from(keyB64, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join('');
}

export function e2eExtensionIdentity(): { key: string; extensionId: string } {
  let key = process.env[ENV];
  if (!key) {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    process.env[ENV] = key;
  }
  return { key, extensionId: extensionIdFromKey(key) };
}
