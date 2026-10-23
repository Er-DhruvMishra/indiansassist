/**
 * The node's Ed25519 key set (contracts sections 3.1, 3.4, 5.6): the current signing seed (TOKEN_SIGNING_KEY or the
 * persisted dev key), its public key and kid, plus retired public keys from TOKEN_SIGNING_KEYS_PREVIOUS. Tokens and
 * audit checkpoints are signed with the current key; verification accepts every listed key.
 */
import {
  publicKeyEntry,
  publicKeyFromSeed,
  publicKeyToBase64url,
  kidOf,
  type PublicKeyEntry,
} from '@indiansassist/shared';

export type KeySet = {
  /** 64 hex chars, never logged. */
  seedHex: string;
  kid: string;
  pub: Uint8Array;
  pubB64: string;
  createdAt: Date;
  /** Current key first, then retired keys. */
  all: PublicKeyEntry[];
};

export async function loadKeySet(seedHex: string, previous: readonly string[], createdAt = new Date()): Promise<KeySet> {
  const pub = await publicKeyFromSeed(seedHex);
  const kid = kidOf(pub);
  const all: PublicKeyEntry[] = [{ kid, pub }];
  for (const p of previous) {
    let entry: PublicKeyEntry;
    try {
      entry = publicKeyEntry(p);
    } catch {
      throw new Error('TOKEN_SIGNING_KEYS_PREVIOUS contains a key that is not base64url of 32 bytes');
    }
    if (!all.some((k) => k.kid === entry.kid)) all.push(entry);
  }
  return { seedHex, kid, pub, pubB64: publicKeyToBase64url(pub), createdAt, all };
}

/** `{ kid, pub }` pairs with base64url keys (JSONL export header). */
export function exportKeys(keys: KeySet): { kid: string; pub: string }[] {
  return keys.all.map((k) => ({ kid: k.kid, pub: publicKeyToBase64url(k.pub) }));
}
