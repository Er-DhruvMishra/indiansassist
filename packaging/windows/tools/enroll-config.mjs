#!/usr/bin/env node
// The signed enroll.iaconfig (Phase D contracts section 12.3) on the packaging side: shape check,
// signature check, and conversion to and from the IA_ENROLL MSI property (base64url).
//
// Format (UTF-8 JSON, <= 16384 bytes, strict: unknown keys are an error):
//   { v: 1, apiOrigin, signalUrl (the region's /signal/device URL), region,
//     token: "<enrollment compact token>", groupId: uuid | null, kid, sig }
//   sig = base64url Ed25519 over utf8(canonicalJson(config minus sig)) by the region's
//   token-signing key `kid` (kid = first 16 hex of sha256(public key)), the C section 2.4 scheme.
// The production file is minted by `GET /api/v1/devices/enroll-config` (section 7.2); the shared
// schema lives in @indiansassist/shared (fleet). This module mirrors it so packaging can check a
// file before it goes into a transform or a deployment tool, without importing workspace code.
//
// CLI:
//   node enroll-config.mjs encode <enroll.iaconfig>             -> IA_ENROLL value on stdout
//   node enroll-config.mjs decode <IA_ENROLL value | @file>     -> the JSON on stdout
//   node enroll-config.mjs check  <enroll.iaconfig> [--pubkey <base64url>]...
//   node enroll-config.mjs sign-dev --seed <hex32> --api-origin <o> --signal-url <u> --region <r>
//        --token <t> [--group-id <uuid>]                       -> a DEV-signed file on stdout
// `sign-dev` is for exercising the MSI pipeline against a local api whose TOKEN_SIGNING_KEY seed
// you hold; production configs only ever come from the api.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ENROLL_CONFIG_MAX_BYTES = 16384;
const KEYS = ['v', 'apiOrigin', 'signalUrl', 'region', 'token', 'groupId', 'kid', 'sig'];
const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------- encodings

export function base64urlEncode(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

/** Strict: base64url alphabet only, no padding, canonical trailing bits. */
export function base64urlDecode(text) {
  if (!B64URL_RE.test(text) || text.length % 4 === 1) throw new Error('not base64url');
  const buf = Buffer.from(text, 'base64url');
  if (buf.toString('base64url') !== text) throw new Error('not canonical base64url');
  return buf;
}

/** Canonical JSON (the JCS subset of packages/shared/src/canonical.ts): sorted keys, no spaces. */
export function canonicalJson(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) throw new Error('canonical JSON allows safe integers only');
      return String(value === 0 ? 0 : value);
    case 'object':
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      return `{${Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
        .join(',')}}`;
    default:
      throw new Error(`unsupported ${typeof value} in canonical JSON`);
  }
}

export function kidOf(publicKeyRaw) {
  if (publicKeyRaw.length !== 32) throw new Error('public key must be 32 bytes');
  return createHash('sha256').update(publicKeyRaw).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- shape

function originRest(s, secure, plain) {
  let rest;
  if (s.startsWith(secure)) rest = s.slice(secure.length);
  else if (s.startsWith(plain)) {
    rest = s.slice(plain.length);
    const host = rest.split(/[:/]/)[0];
    if (host !== 'localhost' && host !== '127.0.0.1') return null;
  } else return null;
  const authority = rest.split('/')[0];
  if (!authority || !/^[A-Za-z0-9.:-]+$/.test(authority)) return null;
  return rest.slice(authority.length);
}

/** Returns a list of problems (empty = well formed). Mirrors packaging/windows/ca/src/enroll.rs. */
export function shapeProblems(cfg) {
  const p = [];
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) return ['not a JSON object'];
  for (const k of Object.keys(cfg)) if (!KEYS.includes(k)) p.push(`unknown key ${k}`);
  for (const k of KEYS) if (!(k in cfg)) p.push(`missing ${k}`);
  if (cfg.v !== 1) p.push('v must be 1');
  if (
    typeof cfg.apiOrigin !== 'string' ||
    cfg.apiOrigin.length > 200 ||
    originRest(cfg.apiOrigin, 'https://', 'http://') !== ''
  )
    p.push('apiOrigin must be an https origin without a path (http only for localhost)');
  if (
    typeof cfg.signalUrl !== 'string' ||
    cfg.signalUrl.length > 300 ||
    originRest(cfg.signalUrl, 'wss://', 'ws://') !== '/signal/device'
  )
    p.push('signalUrl must be wss://<host>/signal/device (ws only for localhost)');
  if (typeof cfg.region !== 'string' || !/^[a-z0-9-]{1,32}$/.test(cfg.region)) p.push('region malformed');
  if (typeof cfg.token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(cfg.token)) p.push('token malformed');
  if ('groupId' in cfg && cfg.groupId !== null && !(typeof cfg.groupId === 'string' && UUID_RE.test(cfg.groupId)))
    p.push('groupId must be a lower-case uuid or null');
  if (typeof cfg.kid !== 'string' || !/^[0-9a-f]{16}$/.test(cfg.kid)) p.push('kid must be 16 lower-case hex');
  if (typeof cfg.sig !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(cfg.sig))
    p.push('sig must be a base64url Ed25519 signature');
  return p;
}

export function parseEnrollConfig(text) {
  if (Buffer.byteLength(text, 'utf8') > ENROLL_CONFIG_MAX_BYTES)
    throw new Error(`larger than ${ENROLL_CONFIG_MAX_BYTES} bytes`);
  const cfg = JSON.parse(text);
  const problems = shapeProblems(cfg);
  if (problems.length) throw new Error(problems.join('; '));
  return cfg;
}

/** The signed bytes: utf8(canonicalJson(config minus sig)). */
export function signingInput(cfg) {
  const { sig: _sig, ...rest } = cfg;
  void _sig;
  return Buffer.from(canonicalJson(rest), 'utf8');
}

// ---------------------------------------------------------------- Ed25519 (node:crypto, no deps)

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function privateKeyFromSeed(seedHex) {
  if (!/^[0-9a-f]{64}$/i.test(seedHex)) throw new Error('seed must be 32 bytes of hex');
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seedHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function publicKeyRawFromSeed(seedHex) {
  const jwk = createPublicKey(privateKeyFromSeed(seedHex)).export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url');
}

/** Signs a config with a token-signing seed; returns the file text (canonical, sorted keys). */
export function signEnrollConfig(fields, seedHex) {
  const kid = kidOf(publicKeyRawFromSeed(seedHex));
  const body = { v: 1, groupId: null, ...fields, kid };
  delete body.sig;
  const sig = sign(null, signingInput(body), privateKeyFromSeed(seedHex));
  const text = canonicalJson({ ...body, sig: base64urlEncode(sig) });
  parseEnrollConfig(text);
  return text;
}

/** True when `sig` verifies against the key in `publicKeysRaw` whose kid matches. */
export function verifyEnrollConfig(cfg, publicKeysRaw) {
  const pub = publicKeysRaw.find((k) => kidOf(k) === cfg.kid);
  if (!pub) return false;
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: base64urlEncode(pub) }, format: 'jwk' });
  return verify(null, signingInput(cfg), key, base64urlDecode(cfg.sig));
}

// ---------------------------------------------------------------- IA_ENROLL

export function toIaEnroll(text) {
  parseEnrollConfig(text);
  return base64urlEncode(Buffer.from(text, 'utf8'));
}

export function fromIaEnroll(value) {
  const text = base64urlDecode(value.trim()).toString('utf8');
  parseEnrollConfig(text);
  return text;
}

// ---------------------------------------------------------------- CLI

function flag(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name && args[i + 1] !== undefined) out.push(args[++i]);
  return out;
}

function main(argv) {
  const [cmd, arg, ...rest] = argv;
  const readArg = (a) => (a.startsWith('@') ? readFileSync(a.slice(1), 'utf8') : a);
  switch (cmd) {
    case 'encode':
      process.stdout.write(`${toIaEnroll(readFileSync(arg, 'utf8'))}\n`);
      return 0;
    case 'decode':
      process.stdout.write(`${fromIaEnroll(readArg(arg))}\n`);
      return 0;
    case 'check': {
      const cfg = parseEnrollConfig(readFileSync(arg, 'utf8'));
      console.log(
        `shape ok: region ${cfg.region}, apiOrigin ${cfg.apiOrigin}, groupId ${cfg.groupId ?? 'null'}, kid ${cfg.kid}`,
      );
      const keys = flag(rest, '--pubkey').map((k) => base64urlDecode(k));
      if (!keys.length) {
        console.log('signature not checked (pass --pubkey <base64url> for the region key set)');
        return 0;
      }
      const ok = verifyEnrollConfig(cfg, keys);
      console.log(ok ? 'signature ok' : 'signature NOT valid for the given keys');
      return ok ? 0 : 2;
    }
    case 'sign-dev': {
      const args = [arg, ...rest];
      const one = (n) => flag(args, n)[0];
      const seed = one('--seed');
      if (!seed) throw new Error('--seed <hex32> is required');
      const text = signEnrollConfig(
        {
          apiOrigin: one('--api-origin'),
          signalUrl: one('--signal-url'),
          region: one('--region'),
          token: one('--token'),
          groupId: one('--group-id') ?? null,
        },
        seed,
      );
      process.stdout.write(`${text}\n`);
      return 0;
    }
    default:
      console.error(
        'usage: enroll-config.mjs encode <file> | decode <value|@file> | check <file> [--pubkey <b64url>] | sign-dev --seed <hex> ...',
      );
      return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`enroll-config: ${e.message}`);
    process.exitCode = 1;
  }
}
