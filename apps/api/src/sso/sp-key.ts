/**
 * Phase E section 3.5 S7 and section 2.6 `sso_cert_invalid`: the SP key pair with its self-signed certificate
 * (`@peculiar/x509`, RSA-2048, SHA-256, 10 years, `CN=<SP entity id>`) and the save-time check of an IdP certificate
 * (RSA of at least 2048 bits, not expired; EC refused because xml-crypto 6 verifies no ECDSA).
 */
import { createHash, generateKeyPairSync, randomBytes, webcrypto, X509Certificate } from 'node:crypto';
import type * as X509 from '@peculiar/x509';
import { installReflectMetadataShim } from './reflect-shim.js';

export const SP_CERT_YEARS = 10;

export type SpKeyMaterial = { privateKeyPem: string; certPem: string; certSha256: string };

type X509Module = typeof X509;
let x509Mod: Promise<X509Module> | null = null;

async function loadX509(): Promise<X509Module> {
  x509Mod ??= (async () => {
    installReflectMetadataShim();
    const m = await import('@peculiar/x509');
    m.cryptoProvider.set(webcrypto as never);
    return m;
  })();
  return x509Mod;
}

/** S7: a fresh RSA-2048 key pair (PKCS#8 PEM) and a self-signed certificate for `entityId`. */
export async function generateSpKey(entityId: string, now: Date = new Date()): Promise<SpKeyMaterial> {
  const x509 = await loadX509();
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
  const alg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const subtle = webcrypto.subtle;
  const priv = await subtle.importKey('pkcs8', privateKey.export({ type: 'pkcs8', format: 'der' }), alg, true, ['sign']);
  const pub = await subtle.importKey('spki', publicKey.export({ type: 'spki', format: 'der' }), alg, true, ['verify']);
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f; // a positive INTEGER
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + SP_CERT_YEARS);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial.toString('hex'),
    name: [{ CN: [entityId] }],
    notBefore: new Date(now.getTime() - 60_000),
    notAfter,
    signingAlgorithm: alg,
    keys: { privateKey: priv as never, publicKey: pub as never },
  });
  const der = Buffer.from(cert.rawData);
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    certPem: cert.toString('pem'),
    certSha256: createHash('sha256').update(der).digest('hex'),
  };
}

/** sha256 hex of a PEM certificate's DER. */
export function certSha256(pem: string): string {
  return createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');
}

export type CertCheck = { ok: true } | { ok: false; reason: 'unparseable' | 'not_rsa' | 'too_short' | 'expired' };

/** Section 2.6 `sso_cert_invalid`: parses, carries an RSA public key of at least 2048 bits, and has not expired. */
export function checkIdpCertificate(pem: string, now: Date = new Date()): CertCheck {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  const key = cert.publicKey;
  if (key.asymmetricKeyType !== 'rsa') return { ok: false, reason: 'not_rsa' };
  if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return { ok: false, reason: 'too_short' };
  const validTo = Date.parse(cert.validTo);
  if (!Number.isFinite(validTo) || validTo <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true };
}
