#!/usr/bin/env node
// Prints the base64url Ed25519 public key and kid of a TOKEN_SIGNING_KEY seed, for TOKEN_SIGNING_KEYS_PREVIOUS
// during key rotation (contracts sections 3.4 and 11.1). The seed is read from the environment, never argv,
// so it does not land in shell history or the process list:
//
//   TOKEN_SIGNING_KEY=<64 hex> node scripts/signing-pubkey.mjs
//   -> pub=<base64url 43 chars>  kid=<16 hex>

import { loadShared } from './smoke/shared.mjs';

const seed = (process.env.TOKEN_SIGNING_KEY ?? '').trim();
if (!/^[0-9a-f]{64}$/i.test(seed)) {
  console.error('signing-pubkey: set TOKEN_SIGNING_KEY to the 64-hex-char seed');
  process.exit(1);
}
const shared = await loadShared();
const pub = await shared.publicKeyFromSeed(seed.toLowerCase());
console.log(`pub=${shared.publicKeyToBase64url(pub)}  kid=${shared.kidOf(pub)}`);
