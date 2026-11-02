/**
 * Phase E section 3.5: SAML 2.0 SP-initiated sign-in with `@node-saml/node-saml` 5.2.
 *
 * node-saml checks the signatures, the Issuer, Conditions, the audience and InResponseTo (through the presence-backed
 * cache provider, S5). It does not enforce Recipient, Destination, InResponseTo against our flow, the AuthnStatement or
 * SHA-1, so the S4 step 6 checks here add them, and they read only XML node-saml validated:
 *
 *  - the assertion content from `profile.getAssertionXml()` (the bytes the assertion signature covers);
 *  - the Response's Destination from the verified Response content, re-derived with node-saml's own
 *    `getVerifiedXml` over the same certificates (in 5.2 `profile.getSamlResponseXml()` returns the Response **as
 *    received**, not as verified, and says so in its debug notice, so it is never read);
 *  - the SignatureMethod and DigestMethod from the `SignedInfo` of the very `ds:Signature` elements node-saml verified
 *    (the single signature child of the Response root and of the single Assertion). `SignedInfo` is what the
 *    SignatureValue covers, and the enveloped-signature transform strips the signature from the signed content, so it
 *    cannot be read from `getAssertionXml()`.
 *
 * Nothing is ever read from a second parse of the raw body for a decision that could accept: the only raw reads are
 * the pre-validation refusals of step 4 (`<!DOCTYPE`, encryption algorithms) and, for an unsigned Response, a
 * Destination that can only refuse.
 */
import { randomBytes } from 'node:crypto';
import {
  LIMITS,
  parseSsoConfig,
  SAML_NAMEID_FORMAT_URNS,
  sha256Hex,
  type SsoAssertion,
  type SsoConfig,
  type SsoErrorCode,
  type SsoFlowRecord,
} from '@indiansassist/shared';
import { getOrg, type OrgRow } from '@indiansassist/db';
import { generateServiceProviderMetadata, SAML, SamlStatusError, type CacheItem, type CacheProvider } from '@node-saml/node-saml';
import { decryptXml, getVerifiedXml, parseDomFromString, xpath } from '@node-saml/node-saml/lib/xml.js';
import type { Presence } from '../adapters/presence.js';
import type { AppContext } from '../context.js';
import { openOrgSecretWithReseal } from '../lib/org-secrets.js';
import { bindingCookieName, bindingMatches, randomHandle, saveFlow } from './flow.js';
import {
  normaliseAssertedEmail,
  normaliseGroups,
  sanitiseName,
  SsoBeginError,
  type SsoBeginInput,
  type SsoBeginResult,
  type SsoCompleteInput,
  type SsoCompleteResult,
  type SsoProvider,
} from './provider.js';
import { spAcsUrl, spEntityId } from './urls.js';

export const SAML_REQ_PREFIX = 'ia:saml:req:';
export const SAML_AID_PREFIX = 'ia:saml:aid:';
const REQUEST_ID_TTL_MS = 600_000;

export const ALLOWED_SIGNATURE_METHODS = new Set([
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha384',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512',
]);
export const ALLOWED_DIGEST_METHODS = new Set([
  'http://www.w3.org/2001/04/xmlenc#sha256',
  'http://www.w3.org/2001/04/xmldsig-more#sha384',
  'http://www.w3.org/2001/04/xmlenc#sha512',
]);
export const ALLOWED_KEY_TRANSPORT = new Set(['http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p', 'http://www.w3.org/2009/xmlenc11#rsa-oaep']);
export const ALLOWED_CONTENT_ENCRYPTION = new Set(['http://www.w3.org/2009/xmlenc11#aes128-gcm', 'http://www.w3.org/2009/xmlenc11#aes256-gcm']);
const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';

// The api compiles without the DOM lib; these follow node-saml's own xml helper signatures.
type XNode = Parameters<typeof xpath.selectElements>[0];
type XElement = ReturnType<typeof xpath.selectElements>[number];
type XDocument = Awaited<ReturnType<typeof parseDomFromString>>;

/**
 * S5: node-saml's request-id cache over presence (`ia:saml:req:`). `saveAsync` maps to `Presence.setKey`; the
 * get-and-remove operation node-saml 5.2 names `consumeAsync` maps to `Presence.consume`, so a request id validates
 * exactly once on any node of the region.
 */
export class PresenceSamlCache implements CacheProvider {
  constructor(private readonly presence: Presence) {}
  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    await this.presence.setKey(SAML_REQ_PREFIX + key, value, Math.ceil(REQUEST_ID_TTL_MS / 1000));
    return { value, createdAt: Date.now() };
  }
  async getAsync(key: string): Promise<string | null> {
    return this.presence.getKey(SAML_REQ_PREFIX + key);
  }
  async removeAsync(key: string | null): Promise<string | null> {
    return key === null ? null : this.presence.consume(SAML_REQ_PREFIX + key);
  }
  async consumeAsync(key: string): Promise<string | null> {
    return this.presence.consume(SAML_REQ_PREFIX + key);
  }
}

/**
 * S5 replay cache: records an assertion id once per org for as long as the assertion could be accepted
 * (`NotOnOrAfter` + skew, clamped to 300..86400 s). False when the id was already seen (`replay`).
 */
export async function recordSamlAssertionId(
  presence: Presence,
  orgId: string,
  assertionId: string,
  latestNotOnOrAfterMs: number | null,
  clockSkewSec: number,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const base = latestNotOnOrAfterMs === null ? 300 : Math.ceil((latestNotOnOrAfterMs - nowMs) / 1000) + clockSkewSec;
  const ttl = Math.min(86_400, Math.max(300, base));
  const n = await presence.incr(`${SAML_AID_PREFIX}${orgId}:${sha256Hex(assertionId)}`, ttl);
  return n === 1;
}

function el(node: XNode, expr: string): XElement[] {
  return xpath.selectElements(node, expr);
}

function child(node: XNode, local: string): XElement[] {
  return el(node, `./*[local-name()='${local}']`);
}

/** S4 step 4: a `<!DOCTYPE` anywhere (any case) is refused before any XML parsing. */
export function hasDoctype(xml: string): boolean {
  return /<!DOCTYPE/i.test(xml);
}

/** S4 step 4: every EncryptedAssertion uses RSA-OAEP key transport and AES-GCM content encryption. */
export function encryptionAlgorithmsOk(doc: XDocument): boolean {
  for (const ea of el(doc, "//*[local-name()='EncryptedAssertion']")) {
    const data = child(ea, 'EncryptedData');
    if (data.length !== 1) return false;
    const dataMethod = child(data[0]!, 'EncryptionMethod');
    if (dataMethod.length !== 1 || !ALLOWED_CONTENT_ENCRYPTION.has(dataMethod[0]!.getAttribute('Algorithm') ?? '')) return false;
    const keys = el(ea, ".//*[local-name()='EncryptedKey']");
    if (keys.length === 0) return false;
    for (const k of keys) {
      const m = child(k, 'EncryptionMethod');
      if (m.length !== 1 || !ALLOWED_KEY_TRANSPORT.has(m[0]!.getAttribute('Algorithm') ?? '')) return false;
    }
    for (const m of el(ea, ".//*[local-name()='EncryptionMethod']")) {
      const a = m.getAttribute('Algorithm') ?? '';
      if (!ALLOWED_KEY_TRANSPORT.has(a) && !ALLOWED_CONTENT_ENCRYPTION.has(a)) return false;
    }
  }
  return true;
}

/** S4 step 6: SignatureMethod rsa-sha256/384/512 and every DigestMethod sha256/384/512 (SHA-1 refused for both). */
export function signatureAlgorithmsOk(signature: XElement): boolean {
  const signedInfo = child(signature, 'SignedInfo');
  if (signedInfo.length !== 1) return false;
  const sm = child(signedInfo[0]!, 'SignatureMethod');
  if (sm.length !== 1 || !ALLOWED_SIGNATURE_METHODS.has(sm[0]!.getAttribute('Algorithm') ?? '')) return false;
  const digests = el(signedInfo[0]!, "./*[local-name()='Reference']/*[local-name()='DigestMethod']");
  if (digests.length === 0) return false;
  return digests.every((d) => ALLOWED_DIGEST_METHODS.has(d.getAttribute('Algorithm') ?? ''));
}

function sameUrl(a: string | null, b: string): boolean {
  if (a === null) return false;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

function signatureOf(element: XElement): XElement | null {
  const sigs = el(element, "./*[local-name()='Signature' and namespace-uri()='http://www.w3.org/2000/09/xmldsig#']");
  return sigs.length === 1 ? sigs[0]! : null;
}

export type ValidatedView = {
  /** The verified assertion (profile.getAssertionXml()). */
  assertionXml: string;
  /** The raw received document (only for locating the verified signature elements and pre-validation refusals). */
  rawXml: string;
  pemCerts: string[];
  decryptionPvk: string | null;
};

export type AssertionFacts = {
  assertionId: string;
  nameId: string | null;
  attributes: Map<string, string[]>;
  sessionNotOnOrAfter: Date | null;
  latestNotOnOrAfterMs: number | null;
};

/**
 * S4 step 6 over the validated XML. Returns the facts S5 / S6 need, or the failure cause.
 */
export async function samlChecks(
  view: ValidatedView,
  expect: { acsUrl: string; requestId: string; clockSkewSec: number; nowMs?: number },
): Promise<{ ok: true; facts: AssertionFacts } | { ok: false; cause: SsoErrorCode }> {
  const bad = { ok: false as const, cause: 'invalid_response' as const };
  const nowMs = expect.nowMs ?? Date.now();
  const skewMs = expect.clockSkewSec * 1000;
  const raw = await parseDomFromString(view.rawXml);
  const root = raw.documentElement;

  // (a) the signatures node-saml verified: algorithms in SignedInfo, never SHA-1.
  let responseVerifiedXml: string | null;
  try {
    responseVerifiedXml = getVerifiedXml(view.rawXml, root, view.pemCerts);
  } catch {
    return bad;
  }
  if (responseVerifiedXml !== null) {
    const rs = signatureOf(root);
    if (!rs || !signatureAlgorithmsOk(rs)) return bad;
  }
  let assertionElement: XElement;
  const plain = child(root, 'Assertion');
  const encrypted = child(root, 'EncryptedAssertion');
  if (plain.length + encrypted.length !== 1) return bad;
  if (plain.length === 1) assertionElement = plain[0]!;
  else {
    if (!view.decryptionPvk) return bad;
    try {
      const dec = await parseDomFromString(await decryptXml(encrypted[0]!.toString(), view.decryptionPvk));
      const a = el(dec, "/*[local-name()='Assertion']");
      if (a.length !== 1) return bad;
      assertionElement = a[0]!;
    } catch {
      return bad;
    }
  }
  const as = signatureOf(assertionElement);
  if (!as || !signatureAlgorithmsOk(as)) return bad;

  // (b) the Response Destination: required and equal when the Response is signed, equal when present otherwise.
  if (responseVerifiedXml !== null) {
    const v = await parseDomFromString(responseVerifiedXml);
    if (!sameUrl(v.documentElement.getAttribute('Destination'), expect.acsUrl)) return bad;
  } else if (root.hasAttribute('Destination') && !sameUrl(root.getAttribute('Destination'), expect.acsUrl)) return bad;

  // (c) the verified assertion content.
  const doc = await parseDomFromString(view.assertionXml);
  const a = doc.documentElement;
  if (a.localName !== 'Assertion') return bad;
  const assertionId = a.getAttribute('ID');
  if (!assertionId) return bad;
  const subjects = child(a, 'Subject');
  if (subjects.length !== 1) return bad;
  const confirmations = child(subjects[0]!, 'SubjectConfirmation');
  if (confirmations.length !== 1 || confirmations[0]!.getAttribute('Method') !== BEARER) return bad;
  const data = child(confirmations[0]!, 'SubjectConfirmationData');
  if (data.length !== 1) return bad;
  const scd = data[0]!;
  if (!sameUrl(scd.getAttribute('Recipient'), expect.acsUrl)) return bad;
  const scdNotOnOrAfter = Date.parse(scd.getAttribute('NotOnOrAfter') ?? '');
  if (!Number.isFinite(scdNotOnOrAfter) || nowMs >= scdNotOnOrAfter + skewMs) return bad;
  if (scd.getAttribute('InResponseTo') !== expect.requestId) return bad;
  const authn = child(a, 'AuthnStatement');
  if (authn.length === 0) return bad;
  const sessionNoa = Date.parse(authn[0]!.getAttribute('SessionNotOnOrAfter') ?? '');

  const nameIds = child(subjects[0]!, 'NameID');
  const nameId = nameIds.length === 1 ? (nameIds[0]!.textContent ?? '').trim() || null : null;
  const attributes = new Map<string, string[]>();
  for (const stmt of child(a, 'AttributeStatement'))
    for (const attr of child(stmt, 'Attribute')) {
      const name = attr.getAttribute('Name');
      if (!name) continue;
      const values = child(attr, 'AttributeValue')
        .map((v) => (v.textContent ?? '').trim())
        .filter((v) => v.length > 0);
      attributes.set(name, [...(attributes.get(name) ?? []), ...values]);
    }
  const conditions = child(a, 'Conditions');
  const condNoa = conditions.length === 1 ? Date.parse(conditions[0]!.getAttribute('NotOnOrAfter') ?? '') : NaN;
  const latest = [scdNotOnOrAfter, condNoa].filter((x) => Number.isFinite(x));
  return {
    ok: true,
    facts: {
      assertionId,
      nameId,
      attributes,
      sessionNotOnOrAfter: Number.isFinite(sessionNoa) ? new Date(sessionNoa) : null,
      latestNotOnOrAfterMs: latest.length > 0 ? Math.max(...latest) : null,
    },
  };
}

/** The opened SP private key of an org, or null when none is set. Throws when it is set but does not open. */
async function openSpKey(ctx: AppContext, org: OrgRow): Promise<string | null> {
  if (!org.ssoSpKeyEnc) return null;
  return openOrgSecretWithReseal(
    ctx,
    ctx.db,
    { orgId: org.id, purpose: 'sso-saml-sp-key', recordId: org.id },
    org.ssoSpKeyEnc,
    { column: 'org.sso_sp_key_enc', rowId: org.id },
  );
}

function normalisePem(pem: string): string {
  return pem.trim();
}

/** S1: the node-saml instance of one org, built only from that org's configuration. */
export function buildSaml(
  ctx: AppContext,
  org: OrgRow,
  cfg: SsoConfig,
  spKey: string | null,
  opts: { requestId?: string } = {},
): SAML {
  const sc = cfg.saml!;
  const entityId = spEntityId(ctx.config, org.id);
  return new SAML({
    entryPoint: sc.ssoUrl,
    issuer: entityId,
    idpIssuer: sc.idpEntityId,
    callbackUrl: spAcsUrl(ctx.config, org.id),
    audience: entityId,
    idpCert: sc.idpCertificates.map(normalisePem),
    ...(sc.signAuthnRequests && spKey ? { privateKey: spKey } : {}),
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
    identifierFormat: SAML_NAMEID_FORMAT_URNS[sc.nameIdFormat],
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: sc.wantResponseSigned,
    validateInResponseTo: 'always' as never,
    rejectReplayedAssertions: false,
    requestIdExpirationPeriodMs: REQUEST_ID_TTL_MS,
    acceptedClockSkewMs: sc.clockSkewSec * 1000,
    maxAssertionAgeMs: 600_000,
    cacheProvider: new PresenceSamlCache(ctx.presence),
    ...(spKey ? { decryptionPvk: spKey } : {}),
    ...(opts.requestId ? { generateUniqueId: () => opts.requestId! } : {}),
  });
}

/**
 * S8: the SP metadata of an org with a SAML config. With an SP key the certificate is listed as `use="signing"` and
 * `use="encryption"` (S7). node-saml emits a KeyDescriptor only when it is handed a key, so it gets a placeholder
 * (`signMetadata` is off, nothing is signed and the sealed key is never opened on this public route); the signing
 * descriptor is passed through node-saml only when AuthnRequests are signed, so `AuthnRequestsSigned` stays honest.
 */
export function spMetadataXml(ctx: AppContext, org: OrgRow, cfg: SsoConfig): string {
  const sc = cfg.saml!;
  const base = {
    issuer: spEntityId(ctx.config, org.id),
    callbackUrl: spAcsUrl(ctx.config, org.id),
    identifierFormat: SAML_NAMEID_FORMAT_URNS[sc.nameIdFormat],
    wantAssertionsSigned: true,
  };
  if (!org.ssoSpCert) return generateServiceProviderMetadata(base);
  const placeholder = 'sealed-key-not-opened';
  if (sc.signAuthnRequests)
    return generateServiceProviderMetadata({
      ...base,
      privateKey: placeholder,
      signatureAlgorithm: 'sha256',
      digestAlgorithm: 'sha256',
      publicCerts: org.ssoSpCert,
      decryptionPvk: placeholder,
      decryptionCert: org.ssoSpCert,
    });
  const xml = generateServiceProviderMetadata({ ...base, decryptionPvk: placeholder, decryptionCert: org.ssoSpCert });
  // Same certificate, also for signing (S7), without claiming that AuthnRequests are signed.
  return xml.replace(/(\s*)(<KeyDescriptor use="encryption">[\s\S]*?<\/KeyDescriptor>)/, (_m, ws: string, block: string) =>
    `${ws}${block.replace('use="encryption"', 'use="signing"').replace(/\s*<EncryptionMethod[^>]*\/>/g, '')}${ws}${block}`,
  );
}

export class SamlSsoProvider implements SsoProvider {
  readonly protocol = 'saml' as const;
  constructor(private readonly ctx: AppContext) {}

  async begin(org: OrgRow, cfg: SsoConfig, input: SsoBeginInput): Promise<SsoBeginResult> {
    if (!cfg.saml) throw new SsoBeginError('sso_disabled');
    let spKey: string | null = null;
    if (cfg.saml.signAuthnRequests) {
      try {
        spKey = await openSpKey(this.ctx, org);
      } catch {
        spKey = null;
      }
      if (!spKey) throw new SsoBeginError('sso_disabled', 'signAuthnRequests is on but no SP key opens');
    }
    const requestId = `_${randomBytes(20).toString('hex')}`;
    const relayState = randomHandle();
    const b = randomHandle();
    const saml = buildSaml(this.ctx, org, cfg, spKey, { requestId });
    let url: string;
    try {
      url = await saml.getAuthorizeUrlAsync(relayState, {});
    } catch {
      throw new SsoBeginError('idp_error', 'the AuthnRequest could not be built');
    }
    await saveFlow(this.ctx.presence, relayState, {
      v: 1,
      orgId: org.id,
      protocol: 'saml',
      bindingHash: sha256Hex(b),
      requestId,
      returnTo: input.returnTo,
      test: input.test,
      actingUserId: input.test ? input.actingUserId : null,
      createdAt: new Date().toISOString(),
    });
    return { redirectUrl: url, bindingCookie: { name: bindingCookieName(relayState), value: b, sameSite: 'none' } };
  }

  async complete(flow: SsoFlowRecord, input: SsoCompleteInput): Promise<SsoCompleteResult> {
    const fail = (cause: SsoErrorCode, email: string | null = null): SsoCompleteResult => ({ ok: false, orgId: flow.orgId, cause, email });
    // (2) the flow is bound to this ACS's org and to SAML; (3) to this browser.
    if (flow.orgId !== input.routeOrgId || flow.protocol !== 'saml') return fail('binding_mismatch');
    if (!bindingMatches(flow, input.bindingCookie)) return fail('binding_mismatch');
    const org = await getOrg(this.ctx.db, flow.orgId);
    const cfg = org ? parseSsoConfig(org.ssoConfig) : null;
    if (!org || !cfg || cfg.protocol !== 'saml' || !cfg.saml || (!cfg.enabled && !flow.test)) return fail('sso_disabled');
    const sc = cfg.saml;
    const samlResponse = input.form?.['SAMLResponse'];
    if (!samlResponse || samlResponse.length > LIMITS.samlResponseMaxBytes) return fail('invalid_response');
    // (4) decode, refuse a DOCTYPE before parsing, then the encryption algorithms (unsigned, so safe to read raw).
    let rawXml: string;
    try {
      rawXml = Buffer.from(samlResponse, 'base64').toString('utf8');
    } catch {
      return fail('invalid_response');
    }
    if (hasDoctype(rawXml) || !rawXml.trimStart().startsWith('<')) return fail('invalid_response');
    try {
      const doc = await parseDomFromString(rawXml);
      if (!encryptionAlgorithmsOk(doc)) return fail('invalid_response');
    } catch {
      return fail('invalid_response');
    }
    let spKey: string | null;
    try {
      spKey = await openSpKey(this.ctx, org);
    } catch {
      spKey = null;
    }
    // (5) node-saml: signatures, Issuer, Conditions, audience, InResponseTo through the presence cache.
    const saml = buildSaml(this.ctx, org, cfg, spKey);
    let profile: Awaited<ReturnType<SAML['validatePostResponseAsync']>>['profile'];
    try {
      profile = (await saml.validatePostResponseAsync({ SAMLResponse: samlResponse })).profile;
    } catch (err) {
      return fail(err instanceof SamlStatusError ? 'idp_error' : 'invalid_response');
    }
    if (!profile || typeof profile.getAssertionXml !== 'function') return fail('invalid_response');
    // (6) our checks, on the validated XML only.
    const checked = await samlChecks(
      { assertionXml: profile.getAssertionXml(), rawXml, pemCerts: sc.idpCertificates.map(normalisePem), decryptionPvk: spKey },
      { acsUrl: spAcsUrl(this.ctx.config, org.id), requestId: flow.requestId, clockSkewSec: sc.clockSkewSec },
    );
    if (!checked.ok) return fail(checked.cause);
    const f = checked.facts;
    // S5: the assertion id once per org, across nodes.
    if (!(await recordSamlAssertionId(this.ctx.presence, org.id, f.assertionId, f.latestNotOnOrAfterMs, sc.clockSkewSec)))
      return fail('replay');
    // S6: claims from the validated assertion.
    if (!f.nameId || f.nameId.length > 1024) return fail('email_missing');
    const emailRaw = sc.emailAttribute === null ? f.nameId : f.attributes.get(sc.emailAttribute)?.[0];
    const email = normaliseAssertedEmail(emailRaw);
    if (!email) return fail('email_missing');
    const assertion: SsoAssertion = {
      protocol: 'saml',
      issuer: sc.idpEntityId,
      subject: f.nameId,
      email,
      emailVerified: null,
      name: sc.nameAttribute ? sanitiseName(f.attributes.get(sc.nameAttribute)?.[0]) : null,
      groups: sc.groupsAttribute ? normaliseGroups(f.attributes.get(sc.groupsAttribute) ?? []) : [],
      notOnOrAfter: f.sessionNotOnOrAfter,
    };
    return { ok: true, org, assertion };
  }
}
