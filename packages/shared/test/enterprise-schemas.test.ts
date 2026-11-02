/**
 * Phase E foundation (docs/specs/phase-e-contracts.md section 15.1): every enterprise/* and rest-{sso,integrations,
 * summary} schema with valid and invalid examples, strictness, the SSO protocol-branch rule, the per-type config and
 * credential schemas, ticketPushRequestSchema, sessionSummaryOutputSchema against SESSION_SUMMARY_JSON_SCHEMA, every
 * section 13.3 action with one actor and a strict chain schema, the additive enum values of section 16.2, a native
 * Linux client and the Linux filename grammar.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AGENT_PLATFORMS,
  AI_INFERENCE_GEO,
  API_ERROR_STATUS,
  AUDIT_ACTIONS,
  CAPTURE_CAUSES,
  CAPTURE_PATHS,
  DEFAULT_AI_POLICY,
  E_ACTION_ACTORS,
  E_AUDIT_ACTIONS,
  E_CHAIN_SCHEMAS,
  INTEGRATION_CONFIG_SCHEMAS,
  INTEGRATION_CREDENTIAL_SCHEMAS,
  INTEGRATION_TYPES,
  LIMITS,
  LOGIN_METHODS,
  ORG_SECRET_PURPOSES,
  PUBLIC_EMAIL_DOMAINS,
  REDACTION_KINDS,
  SAML_NAMEID_FORMAT_URNS,
  SESSION_SUMMARY_JSON_SCHEMA,
  SUMMARY_EVENT_ACTIONS,
  SUMMARY_OUTCOMES,
  ZOHO_DATA_CENTERS,
  agentCapabilitiesSchema,
  agentControlEventSchema,
  agentDistFileName,
  agentLinuxFileName,
  aiCapabilitiesSchema,
  aiPolicyPatchSchema,
  aiPolicySchema,
  aiSessionSummarySchema,
  archAllowed,
  auditDataSchema,
  chainDigestEventSchema,
  dataCategorySchema,
  dataFlowSchema,
  deskClientSchema,
  downloadPrepareSchema,
  emailDomainOf,
  emptyRedactionCounts,
  integrationPutRequestSchema,
  integrationSchema,
  isPublicEmailDomain,
  luhnValid,
  newRedactionState,
  normaliseDomain,
  orgSchema,
  parseAgentLinuxFileName,
  parseAiPolicy,
  parseSsoConfig,
  redactText,
  redactionCountsSchema,
  residencyReportSchema,
  residencySignatureSchema,
  resolveJitRole,
  safeReturnTo,
  secretStatusSchema,
  sessionSummaryListSchema,
  sessionSummaryMetaSchema,
  sessionSummaryOutputSchema,
  ssoBreakGlassPutSchema,
  ssoConfigSchema,
  ssoDiscoverySchema,
  ssoDomainSchema,
  ssoFlowRecordSchema,
  ssoPutRequestSchema,
  ssoRequiredPatchSchema,
  ssoSettingsSchema,
  ssoTxtName,
  ssoTxtValue,
  summaryEditRequestSchema,
  summaryPromptInputSchema,
  summaryTranscriptUploadSchema,
  ticketContentSchema,
  ticketFailureSchema,
  ticketPushRequestSchema,
  ticketPushSchema,
  userSchema,
  webhookStoredConfigSchema,
  type SsoConfig,
} from '../src/index.js';

const U = '6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const U2 = '7a2d3b8f-4c5e-4f60-9bac-1d2e3f4a5b6c';
const TS = '2026-11-01T10:00:00.000Z';
const H = 'a'.repeat(64);
const ok = (s: z.ZodType, v: unknown) => s.safeParse(v).success;

const JIT = { enabled: false, defaultRole: 'technician', defaultSeatTier: 'p1_browser', groupRoles: [] } as const;
const OIDC: SsoConfig = {
  v: 1,
  protocol: 'oidc',
  enabled: true,
  displayName: 'Okta',
  oidc: {
    issuer: 'https://example.okta.com',
    clientId: 'client-1',
    tokenEndpointAuth: 'client_secret_basic',
    scopes: ['openid', 'email', 'profile'],
    emailClaim: 'email',
    nameClaim: 'name',
    groupsClaim: null,
    requiredClaims: [],
  },
  saml: null,
  jit: { ...JIT, groupRoles: [] },
  sessionMaxAgeHours: 12,
};
const CERT = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
const SAML: SsoConfig = {
  ...OIDC,
  protocol: 'saml',
  displayName: 'Entra ID',
  oidc: null,
  saml: {
    idpEntityId: 'https://sts.windows.net/tenant/',
    ssoUrl: 'https://login.microsoftonline.com/tenant/saml2',
    idpCertificates: [CERT],
    nameIdFormat: 'email',
    emailAttribute: null,
    nameAttribute: null,
    groupsAttribute: null,
    signAuthnRequests: false,
    wantResponseSigned: false,
    clockSkewSec: 120,
  },
};

describe('additive enum values (section 16.2)', () => {
  it('extends the A-D lists without reordering them', () => {
    expect(INTEGRATION_TYPES).toEqual(['zoho_desk', 'servicenow', 'jira', 'freshdesk', 'webhook']);
    expect(LOGIN_METHODS).toEqual(['local', 'invite', 'oidc', 'saml']);
    // Phase F sections 9.2, 17.8 extend these lists at their ends (phase-f-schemas.test.ts).
    expect(AGENT_PLATFORMS.slice(0, 3)).toEqual(['windows', 'android', 'linux']);
    expect(CAPTURE_PATHS.slice(0, 6)).toEqual(['dda', 'gdi', 'projection', 'xshm', 'xgetimage', 'none']);
    expect(CAPTURE_CAUSES.slice(0, 6)).toEqual(['start', 'dda_lost', 'secure_desktop', 'recovered', 'wayland_unsupported', 'x11_lost']);
    expect(ORG_SECRET_PURPOSES.slice(0, 4)).toEqual(['sso-oidc-client-secret', 'sso-saml-sp-key', 'integration-credentials', 'webhook-secret']);
    expect(AI_INFERENCE_GEO).toEqual({ 'us-east': 'us', 'in-mum': null, 'eu-fra': null });
    expect(PUBLIC_EMAIL_DOMAINS).toHaveLength(30);
    expect(SAML_NAMEID_FORMAT_URNS.persistent).toBe('urn:oasis:names:tc:SAML:2.0:nameid-format:persistent');
  });
  it('adds the section 13.1 LIMITS', () => {
    expect(LIMITS).toMatchObject({
      ssoFlowTtlSec: 600,
      ssoDomainsMax: 20,
      ssoDomainRecheckHours: 168,
      ssoBreakGlassMax: 2,
      breakGlassSessionHours: 1,
      samlResponseMaxBytes: 262144,
      ticketPushMaxAttempts: 6,
      ticketPushManualRetries: 3,
      ticketBodyMax: 20000,
      summaryInputMaxBytes: 131072,
      summaryEventsMax: 400,
      summaryTranscriptTtlSec: 1800,
      summaryTranscriptGraceSec: 20,
      summaryTranscriptUploadMaxBytes: 524288,
      summaryMaxAttempts: 4,
      summaryConcurrency: 2,
      webhookRotationOverlapHours: 24,
    });
  });
  it('adds the section 2.6 error codes with their statuses', () => {
    const want: Record<string, number> = {
      sso_required: 403,
      sso_not_ready: 409,
      sso_required_on: 409,
      last_break_glass: 409,
      break_glass_invalid_user: 400,
      sso_discovery_failed: 400,
      sso_cert_invalid: 400,
      domain_invalid: 400,
      domain_not_allowed: 400,
      domain_taken: 409,
      domain_exists: 409,
      push_id_conflict: 409,
      domain_limit: 409,
      domain_unverified: 409,
      egress_refused: 400,
      integration_not_configured: 409,
      integration_disabled: 409,
      session_not_ended: 409,
      summary_not_ready: 409,
      summary_running: 409,
      summary_conflict: 409,
      retry_limit: 409,
      ai_provider_unavailable: 409,
      ai_ack_required: 400,
      ai_disabled: 409,
      ai_transcript_disabled: 409,
      transcript_notice_missing: 409,
    };
    for (const [code, status] of Object.entries(want)) expect((API_ERROR_STATUS as Record<string, number>)[code], code).toBe(status);
  });
  it('every SUMMARY_EVENT_ACTIONS entry is an audit action', () => {
    for (const a of SUMMARY_EVENT_ACTIONS) expect(AUDIT_ACTIONS as readonly string[]).toContain(a);
  });
});

describe('native Linux client, platform and filename grammar (sections 7.3a, 7.6)', () => {
  const NATIVE = {
    kind: 'native',
    version: '0.4.0',
    os: 'linux',
    platform: { osVersion: 'Ubuntu 26.04.1 LTS', arch: 'x64' },
    tokenSource: 'filename',
    capabilities: { monitors: 1, elevation: 'user', features: ['files', 'chat', 'playbooks'], encoders: ['vp8', 'vp9'], hwEncoder: false, interpreters: ['sh'] },
  };
  it('deskClientSchema accepts a native linux client (Wayland capabilities)', () => {
    expect(ok(deskClientSchema, NATIVE)).toBe(true);
    expect(ok(agentCapabilitiesSchema, NATIVE.capabilities)).toBe(true);
    expect(ok(deskClientSchema, { ...NATIVE, kind: 'web', platform: undefined, tokenSource: undefined, capabilities: undefined, version: undefined })).toBe(true);
  });
  it('the capture event carries the Linux paths and causes', () => {
    const e = { t: 'ctl.event', kind: 'capture', ts: 1, monitorId: 1 };
    expect(ok(agentControlEventSchema, { ...e, path: 'none', cause: 'wayland_unsupported' })).toBe(true);
    expect(ok(agentControlEventSchema, { ...e, path: 'xshm', cause: 'start' })).toBe(true);
    expect(ok(agentControlEventSchema, { ...e, path: 'xgetimage', cause: 'x11_lost' })).toBe(true);
    expect(ok(agentControlEventSchema, { ...e, path: 'pipewire', cause: 'start' })).toBe(false);
  });
  it('linux serves x64 only, as a raw ELF dist file', () => {
    expect(archAllowed('linux', 'x64')).toBe(true);
    expect(archAllowed('linux', 'arm64')).toBe(false);
    expect(archAllowed('linux', 'universal')).toBe(false);
    expect(agentDistFileName('linux', 'x64', '0.4.0')).toBe('IndiansAssist-linux-x64-0.4.0');
    expect(agentDistFileName('windows', 'x64', '0.4.0')).toBe('IndiansAssist-windows-x64-0.4.0.exe');
    expect(ok(downloadPrepareSchema, { code: 'x', platform: 'linux', arch: 'x64' })).toBe(true);
    expect(ok(downloadPrepareSchema, { code: 'x', platform: 'linux', arch: 'arm64' })).toBe(false);
  });
  it('the inner binary name round-trips and is case-sensitive, with no extension or suffix', () => {
    const name = agentLinuxFileName('in-mum', '482193657715');
    expect(name).toBe('IndiansAssist-in-mum-4821-9365-7715');
    expect(parseAgentLinuxFileName(name)).toEqual({ region: 'in-mum', deskCode: '482193657715' });
    expect(parseAgentLinuxFileName(`${name}.exe`)).toBeNull();
    expect(parseAgentLinuxFileName(`${name} (1)`)).toBeNull();
    expect(parseAgentLinuxFileName(name.replace('in-mum', 'IN-MUM'))).toBeNull();
    expect(() => agentLinuxFileName('in-mum', '123')).toThrow();
  });
  it('the agent-names.json Linux vectors equal what the parser returns', () => {
    const names = JSON.parse(readFileSync(new URL('./fixtures/agent/agent-names.json', import.meta.url), 'utf8')) as {
      linuxFileNames: { name: string; parsed: unknown }[];
    };
    expect(names.linuxFileNames.length).toBeGreaterThanOrEqual(6);
    expect(names.linuxFileNames.filter((v) => v.parsed !== null).length).toBeGreaterThanOrEqual(3);
    for (const v of names.linuxFileNames) expect(parseAgentLinuxFileName(v.name), v.name).toEqual(v.parsed);
  });
});

describe('enterprise/secrets', () => {
  it('SecretStatus is strict and never carries a value', () => {
    expect(ok(secretStatusSchema, { set: true, setAt: TS, fingerprint: '0a1b2c3d' })).toBe(true);
    expect(ok(secretStatusSchema, { set: false, setAt: null, fingerprint: null })).toBe(true);
    expect(ok(secretStatusSchema, { set: true, setAt: TS, fingerprint: '0A1B2C3D' })).toBe(false);
    expect(ok(secretStatusSchema, { set: true, setAt: TS, fingerprint: '0a1b2c3d', value: 'hunter2' })).toBe(false);
  });
});

describe('enterprise/sso', () => {
  it('accepts an OIDC and a SAML config', () => {
    expect(ssoConfigSchema.parse(OIDC)).toEqual(OIDC);
    expect(ssoConfigSchema.parse(SAML)).toEqual(SAML);
  });
  it('enforces the protocol-branch rule', () => {
    expect(ok(ssoConfigSchema, { ...OIDC, oidc: null })).toBe(false);
    expect(ok(ssoConfigSchema, { ...OIDC, saml: SAML.saml })).toBe(false);
    expect(ok(ssoConfigSchema, { ...SAML, saml: null })).toBe(false);
    expect(ok(ssoConfigSchema, { ...SAML, oidc: OIDC.oidc })).toBe(false);
  });
  it("requires 'openid', a required claim for Google, and an email attribute unless the NameID is the email", () => {
    expect(ok(ssoConfigSchema, { ...OIDC, oidc: { ...OIDC.oidc!, scopes: ['email'] } })).toBe(false);
    const google = { ...OIDC.oidc!, issuer: 'https://accounts.google.com' };
    expect(ok(ssoConfigSchema, { ...OIDC, oidc: google })).toBe(false);
    expect(ok(ssoConfigSchema, { ...OIDC, oidc: { ...google, requiredClaims: [{ name: 'hd', values: ['example.com'] }] } })).toBe(true);
    expect(ok(ssoConfigSchema, { ...SAML, saml: { ...SAML.saml!, nameIdFormat: 'persistent' } })).toBe(false);
    expect(ok(ssoConfigSchema, { ...SAML, saml: { ...SAML.saml!, nameIdFormat: 'persistent', emailAttribute: 'mail' } })).toBe(true);
  });
  it('is strict, bounded and never maps JIT to org_admin', () => {
    expect(ok(ssoConfigSchema, { ...OIDC, extra: 1 })).toBe(false);
    expect(ok(ssoConfigSchema, { ...OIDC, v: 2 })).toBe(false);
    expect(ok(ssoConfigSchema, { ...OIDC, sessionMaxAgeHours: 169 })).toBe(false);
    expect(ok(ssoConfigSchema, { ...OIDC, jit: { ...JIT, defaultRole: 'org_admin' } })).toBe(false);
    expect(ok(ssoConfigSchema, { ...OIDC, jit: { ...JIT, groupRoles: [{ group: 'admins', role: 'org_admin' }] } })).toBe(false);
    expect(ok(ssoConfigSchema, { ...OIDC, oidc: { ...OIDC.oidc!, issuer: 'javascript:alert(1)' } })).toBe(false);
    expect(ok(ssoConfigSchema, { ...SAML, saml: { ...SAML.saml!, idpCertificates: ['not a cert'] } })).toBe(false);
    expect(ok(ssoConfigSchema, { ...SAML, saml: { ...SAML.saml!, clockSkewSec: 301 } })).toBe(false);
  });
  it('parseSsoConfig never throws on a legacy value', () => {
    expect(parseSsoConfig(null)).toBeNull();
    expect(parseSsoConfig({ issuer: 'old' })).toBeNull();
    expect(parseSsoConfig(OIDC)?.protocol).toBe('oidc');
  });
  it('flow records (O3 / S2) and domains', () => {
    const base = { v: 1, orgId: U, bindingHash: H, returnTo: '/app', test: false, actingUserId: null, createdAt: TS };
    expect(ok(ssoFlowRecordSchema, { ...base, protocol: 'oidc', codeVerifier: 'v'.repeat(43), nonce: 'n'.repeat(43) })).toBe(true);
    expect(ok(ssoFlowRecordSchema, { ...base, protocol: 'saml', requestId: '_abc' })).toBe(true);
    expect(ok(ssoFlowRecordSchema, { ...base, protocol: 'saml', codeVerifier: 'v'.repeat(43), nonce: 'n' })).toBe(false);
    expect(ok(ssoFlowRecordSchema, { ...base, protocol: 'oidc', requestId: '_abc' })).toBe(false);
    const d = { id: U, domain: 'example.com', status: 'pending', txtName: ssoTxtName('example.com'), txtValue: ssoTxtValue('0123456789abcdef0123456789abcdef'), verifiedAt: null, lastCheckedAt: null, createdAt: TS };
    expect(ok(ssoDomainSchema, d)).toBe(true);
    expect(d.txtName).toBe('_indiansassist.example.com');
    expect(ok(ssoDomainSchema, { ...d, status: 'expired' })).toBe(false);
    expect(ok(ssoDomainSchema, { ...d, txtValue: 'ia-verify=XYZ' })).toBe(false);
  });
  it('normaliseDomain applies the domain_invalid rule after IDNA', () => {
    expect(normaliseDomain('Example.COM')).toBe('example.com');
    expect(normaliseDomain('  sub.example.co.in ')).toBe('sub.example.co.in');
    expect(normaliseDomain('bücher.de')).toBe('xn--bcher-kva.de');
    for (const bad of ['localhost', '*.example.com', 'example', '-a.com', 'a-.com', 'example.123', '1.2.3.4', 'a..com', 'ex ample.com', 'example.com/path', 'user@example.com', 'example.com:443', `${'a'.repeat(64)}.com`, ''])
      expect(normaliseDomain(bad), bad).toBeNull();
    expect(emailDomainOf('Priya@Example.com')).toBe('example.com');
    expect(emailDomainOf('no-at-sign')).toBeNull();
    expect(isPublicEmailDomain('GMAIL.com')).toBe(true);
    expect(isPublicEmailDomain('example.com')).toBe(false);
  });
  it('safeReturnTo keeps only /app paths', () => {
    expect(safeReturnTo('/app/sessions/1?x=1')).toBe('/app/sessions/1?x=1');
    expect(safeReturnTo('/app')).toBe('/app');
    for (const bad of ['https://evil.test/app', '//evil.test', '/app//evil', '/app\\x', '/apple', '/login', 'app', '/app/\n', `/app/${'x'.repeat(520)}`, undefined, 5])
      expect(safeReturnTo(bad)).toBe('/app');
  });
  it('resolveJitRole takes the first matching group, else the default', () => {
    const jit = { defaultRole: 'observer' as const, groupRoles: [{ group: 'helpdesk', role: 'technician' as const }, { group: 'leads', role: 'senior_technician' as const }] };
    expect(resolveJitRole(jit, ['leads', 'helpdesk'])).toBe('technician');
    expect(resolveJitRole(jit, ['leads'])).toBe('senior_technician');
    expect(resolveJitRole(jit, [])).toBe('observer');
  });
});

describe('rest-sso', () => {
  const status = { set: false, setAt: null, fingerprint: null };
  const settings = {
    config: OIDC,
    required: false,
    secrets: { clientSecret: status, spKey: status },
    sp: { entityId: 'e', acsUrl: 'a', metadataUrl: 'm', oidcRedirectUri: 'r', certPem: null },
    domains: [],
    breakGlassUserIds: [],
    lastTest: null,
  };
  it('settings, discovery and requests', () => {
    expect(ok(ssoSettingsSchema, settings)).toBe(true);
    expect(ok(ssoSettingsSchema, { ...settings, secrets: { ...settings.secrets, clientSecret: { ...status, value: 'x' } } })).toBe(false);
    expect(ok(ssoDiscoverySchema, { mode: 'password' })).toBe(true);
    expect(ok(ssoDiscoverySchema, { mode: 'sso_required', displayName: 'Okta', beginUrl: '/api/v1/auth/sso/acme/begin' })).toBe(true);
    expect(ok(ssoDiscoverySchema, { mode: 'magic' })).toBe(false);
    expect(ok(ssoPutRequestSchema, { config: OIDC })).toBe(true);
    expect(ok(ssoPutRequestSchema, { config: OIDC, clientSecret: null })).toBe(true);
    expect(ok(ssoPutRequestSchema, { config: OIDC, clientSecret: '' })).toBe(false);
    expect(ok(ssoRequiredPatchSchema, { required: true, dryRun: true })).toBe(true);
    expect(ok(ssoBreakGlassPutSchema, { userIds: [U, U2] })).toBe(true);
    expect(ok(ssoBreakGlassPutSchema, { userIds: [U, U2, U] })).toBe(false);
  });
});

describe('enterprise/integrations and rest-integrations', () => {
  it('ships no unverified Zoho data centre, so no zoho config validates yet', () => {
    expect(ZOHO_DATA_CENTERS).toEqual([]);
    expect(ok(INTEGRATION_CONFIG_SCHEMAS.zoho_desk, { dataCenter: 'in', orgId: '1', departmentId: '2', defaultContactEmail: 'a@b.co', priority: null })).toBe(false);
  });
  it('per-type config schemas', () => {
    const C = INTEGRATION_CONFIG_SCHEMAS;
    expect(ok(C.servicenow, { instanceUrl: 'https://acme.service-now.com', callerId: null, assignmentGroup: 'f'.repeat(32), urgency: 2 })).toBe(true);
    expect(ok(C.servicenow, { instanceUrl: 'https://acme.service-now.com/path', callerId: null, assignmentGroup: null, urgency: null })).toBe(false);
    expect(ok(C.servicenow, { instanceUrl: 'https://acme.service-now.com', callerId: 'xyz', assignmentGroup: null, urgency: null })).toBe(false);
    expect(ok(C.jira, { siteUrl: 'https://acme.atlassian.net', deployment: 'cloud', projectKey: 'OPS', issueType: 'Task', labels: ['remote'] })).toBe(true);
    expect(ok(C.jira, { siteUrl: 'https://acme.atlassian.net', deployment: 'cloud', projectKey: 'ops', issueType: 'Task', labels: [] })).toBe(false);
    expect(ok(C.jira, { siteUrl: 'https://acme.atlassian.net', deployment: 'cloud', projectKey: 'OPS', issueType: 'Task', labels: ['two words'] })).toBe(false);
    expect(ok(C.freshdesk, { domain: 'acme', defaultRequesterEmail: 'it@acme.test', priority: 2, groupId: null })).toBe(true);
    expect(ok(C.freshdesk, { domain: 'acme.freshdesk.com', defaultRequesterEmail: 'it@acme.test', priority: 2, groupId: null })).toBe(false);
    expect(ok(C.freshdesk, { domain: 'acme', defaultRequesterEmail: 'it@acme.test', priority: 5, groupId: null })).toBe(false);
    expect(ok(C.webhook, { url: 'https://hooks.example.test/T000/B000/secretpath?x=1' })).toBe(true);
    expect(ok(C.webhook, { url: 'https://user:pass@hooks.example.test/' })).toBe(false);
    expect(ok(C.webhook, { url: 'ftp://hooks.example.test/' })).toBe(false);
    expect(ok(webhookStoredConfigSchema, { origin: 'https://hooks.example.test', pathSet: true })).toBe(true);
    expect(ok(webhookStoredConfigSchema, { origin: 'https://hooks.example.test', pathSet: true, url: 'x' })).toBe(false);
  });
  it('per-type credential schemas', () => {
    const K = INTEGRATION_CREDENTIAL_SCHEMAS;
    expect(ok(K.zoho_desk, { clientId: 'a', clientSecret: 'b', refreshToken: 'c' })).toBe(true);
    expect(ok(K.zoho_desk, { clientId: 'a', clientSecret: '', refreshToken: 'c' })).toBe(false);
    expect(ok(K.servicenow, { username: 'u', password: 'p' })).toBe(true);
    expect(ok(K.jira, { email: 'a@b.co', apiToken: 't' })).toBe(true);
    expect(ok(K.jira, { personalAccessToken: 't' })).toBe(true);
    expect(ok(K.jira, { email: 'a@b.co', apiToken: 't', personalAccessToken: 't' })).toBe(false);
    expect(ok(K.freshdesk, { apiKey: 'k' })).toBe(true);
    expect(ok(K.webhook, { url: 'https://h.test/x', secret: 'A'.repeat(43), previousSecret: null })).toBe(true);
    expect(ok(K.webhook, { url: 'https://h.test/x', secret: 'short', previousSecret: null })).toBe(false);
  });
  const content = {
    title: 'Remote support session 2026-11-01 — Priya',
    body: 'Fixed the printer.',
    source: 'manual',
    session: { id: U, url: `https://app.example.test/app/sessions/${U}`, tier: 'p3_portable', startedAt: TS, endedAt: TS, technician: 'Priya', chainVerified: true },
    summary: null,
    priority: 'normal',
    requesterEmail: null,
  };
  it('ticket content and failure', () => {
    expect(ok(ticketContentSchema, content)).toBe(true);
    expect(ok(ticketContentSchema, { ...content, body: '' })).toBe(false);
    expect(ok(ticketContentSchema, { ...content, body: 'x'.repeat(20001) })).toBe(false);
    expect(ok(ticketContentSchema, { ...content, extra: 1 })).toBe(false);
    expect(ok(ticketFailureSchema, { cause: 'rate_limited', status: 429, retryAfterSec: 30, sent: true, detail: '' })).toBe(true);
    expect(ok(ticketFailureSchema, { cause: 'rate_limited', status: 429, retryAfterSec: 7201, sent: true, detail: '' })).toBe(false);
    expect(ok(ticketFailureSchema, { cause: 'teapot', status: 418, retryAfterSec: null, sent: true, detail: '' })).toBe(false);
  });
  it('ticketPushRequestSchema: append needs externalId, manual needs note', () => {
    const base = { sessionId: U, clientPushId: U2, mode: 'create', source: 'summary' };
    expect(ok(ticketPushRequestSchema, base)).toBe(true);
    expect(ok(ticketPushRequestSchema, { ...base, mode: 'append' })).toBe(false);
    expect(ok(ticketPushRequestSchema, { ...base, mode: 'append', externalId: 'OPS-12' })).toBe(true);
    expect(ok(ticketPushRequestSchema, { ...base, externalId: 'OPS-12' })).toBe(false);
    expect(ok(ticketPushRequestSchema, { ...base, source: 'manual' })).toBe(false);
    expect(ok(ticketPushRequestSchema, { ...base, source: 'manual', note: 'done' })).toBe(true);
    expect(ok(ticketPushRequestSchema, { ...base, note: 'done' })).toBe(false);
    expect(ok(ticketPushRequestSchema, { ...base, priority: 'urgent', requesterEmail: 'a@b.co', title: 'T', summaryVersion: 2 })).toBe(true);
    expect(ok(ticketPushRequestSchema, { ...base, unknown: 1 })).toBe(false);
  });
  it('push, integration and put request', () => {
    const push = {
      id: U, sessionId: U2, type: 'jira', mode: 'create', source: 'manual', summary: null, state: 'retrying', attempts: 1, manualRetries: 0,
      nextAttemptAt: TS, externalId: null, externalUrl: null, lastFailure: { cause: 'rate_limited', status: 429, retryAfterSec: 30, sent: true, detail: '' },
      contentSha256: H, createdBy: { id: U, name: 'Priya' }, createdAt: TS, deliveredAt: null,
    };
    expect(ok(ticketPushSchema, push)).toBe(true);
    expect(ok(ticketPushSchema, { ...push, content: content })).toBe(false);
    const integ = { type: 'webhook', enabled: true, config: { origin: 'https://h.test', pathSet: true }, credentials: { set: true, setAt: TS, fingerprint: '01234567' }, lastTest: null, updatedAt: TS, updatedBy: null };
    expect(ok(integrationSchema, integ)).toBe(true);
    expect(ok(integrationSchema, { ...integ, type: 'connectwise' })).toBe(false);
    expect(ok(integrationPutRequestSchema, { enabled: true, config: {}, credentials: null })).toBe(true);
  });
});

describe('enterprise/summary and rest-summary', () => {
  const output = { summary: 'Fixed the printer.', outcome: 'resolved', actionsTaken: ['Restarted the spooler'], issuesFound: [], followUps: [], ticketNote: 'Restarted the print spooler.' };
  it('sessionSummaryOutputSchema matches SESSION_SUMMARY_JSON_SCHEMA (same required keys and enums)', () => {
    expect(ok(sessionSummaryOutputSchema, output)).toBe(true);
    const shapeKeys = Object.keys(sessionSummaryOutputSchema.shape).sort();
    expect([...SESSION_SUMMARY_JSON_SCHEMA.required].sort()).toEqual(shapeKeys);
    expect(Object.keys(SESSION_SUMMARY_JSON_SCHEMA.properties).sort()).toEqual(shapeKeys);
    expect(SESSION_SUMMARY_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(SESSION_SUMMARY_JSON_SCHEMA.properties.outcome.enum).toEqual([...SUMMARY_OUTCOMES]);
    const allowed = new Set(['type', 'properties', 'required', 'items', 'enum', 'additionalProperties']);
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      for (const [k, v] of Object.entries(node)) {
        if (k === 'properties') {
          for (const p of Object.values(v as object)) walk(p);
          continue;
        }
        expect(allowed.has(k), k).toBe(true);
        walk(v);
      }
    };
    walk(SESSION_SUMMARY_JSON_SCHEMA);
    for (const [k, v] of Object.entries(SESSION_SUMMARY_JSON_SCHEMA.properties)) {
      const zodType = (sessionSummaryOutputSchema.shape as Record<string, z.ZodType>)[k]!;
      const sample = v.type === 'array' ? [] : v.type === 'string' && 'enum' in v ? v.enum[0] : 'x';
      expect(zodType.safeParse(sample).success, k).toBe(true);
    }
  });
  it('output bounds and strictness', () => {
    expect(ok(sessionSummaryOutputSchema, { ...output, outcome: 'great' })).toBe(false);
    expect(ok(sessionSummaryOutputSchema, { ...output, summary: 'x'.repeat(1501) })).toBe(false);
    expect(ok(sessionSummaryOutputSchema, { ...output, actionsTaken: Array(26).fill('a') })).toBe(false);
    expect(ok(sessionSummaryOutputSchema, { ...output, extra: 1 })).toBe(false);
  });
  it('the AI policy, its default, the patch and capabilities', () => {
    expect(aiPolicySchema.parse(DEFAULT_AI_POLICY)).toEqual({ provider: 'none', autoSummarize: false, includeTranscript: false, anthropicAck: null });
    expect(ok(aiPolicySchema, { ...DEFAULT_AI_POLICY, provider: 'anthropic', anthropicAck: { scope: 'outside_region', textVersion: 'ai-ack-v2', userId: U, at: TS } })).toBe(true);
    expect(ok(aiPolicySchema, { ...DEFAULT_AI_POLICY, anthropicAck: { scope: 'outside_region', textVersion: 'ai-ack-v1', userId: U, at: TS } })).toBe(false);
    expect(ok(aiPolicySchema, { ...DEFAULT_AI_POLICY, provider: 'openai' })).toBe(false);
    expect(parseAiPolicy({ garbage: true })).toEqual(DEFAULT_AI_POLICY);
    expect(ok(aiPolicyPatchSchema, { provider: 'anthropic', acknowledge: { scope: 'in_geo', text: 'I confirm' } })).toBe(true);
    expect(ok(aiPolicyPatchSchema, { provider: 'anthropic', acknowledge: { scope: 'everywhere', text: 'x' } })).toBe(false);
    expect(ok(aiCapabilitiesSchema, { region: 'in-mum', local: true, anthropic: { available: false, inferenceGeo: null, ackScope: 'outside_region' } })).toBe(true);
    expect(ok(aiCapabilitiesSchema, { region: 'in-mum', local: true, anthropic: { available: false, inferenceGeo: 'in', ackScope: null } })).toBe(false);
  });
  it('the transcript upload, the prompt input and digest events', () => {
    const upload = { noticeSentAt: TS, noticeProvider: 'local', messages: [{ from: 'user', at: TS, text: 'hi' }], playbookOutputs: [{ runId: 'a'.repeat(32), stdoutTail: 'ok', stderrTail: '' }], consoleRedaction: 'redact-v1' };
    expect(ok(summaryTranscriptUploadSchema, upload)).toBe(true);
    expect(ok(summaryTranscriptUploadSchema, { ...upload, consoleRedaction: 'none' })).toBe(false);
    expect(ok(summaryTranscriptUploadSchema, { ...upload, messages: [{ from: 'desk', at: TS, text: 'hi' }] })).toBe(false);
    expect(ok(summaryTranscriptUploadSchema, { ...upload, messages: Array(501).fill(upload.messages[0]) })).toBe(false);
    expect(ok(chainDigestEventSchema, { t: TS, actor: 'technician', text: 'Sent a .log file (2.1 MB)' })).toBe(true);
    expect(ok(chainDigestEventSchema, { t: TS, actor: 'Priya', text: 'x' })).toBe(false);
    const input = {
      v: 1, promptVersion: 'summary-prompt-v1',
      session: { tier: 'p3_portable', startedAt: TS, endedAt: TS, durationMs: 1000, endReason: 'assist_ended', path: 'p2p', recorded: false, unattended: null },
      events: [{ t: TS, actor: 'system', text: 'Session ended' }], transcript: null, truncated: false,
    };
    expect(ok(summaryPromptInputSchema, input)).toBe(true);
    expect(ok(summaryPromptInputSchema, { ...input, promptVersion: 'summary-prompt-v2' })).toBe(false);
  });
  it('summary meta, list and edit request', () => {
    const meta = {
      id: U, sessionId: U2, version: 1, state: 'ready', trigger: 'session_end', provider: 'local', model: 'local', servedModel: 'local', inferenceGeo: 'in-mum',
      fallbackUsed: false, transcriptIncluded: true, normalised: false, redactions: emptyRedactionCounts(), sha256: H, inputSha256: H, cause: null, attempts: 1,
      createdBy: null, editedBy: null, createdAt: TS, completedAt: TS,
    };
    expect(ok(sessionSummaryMetaSchema, meta)).toBe(true);
    expect(ok(aiSessionSummarySchema, { ...meta, output })).toBe(true);
    expect(ok(sessionSummaryMetaSchema, { ...meta, output })).toBe(false);
    expect(ok(sessionSummaryListSchema, { latest: null, versions: [meta] })).toBe(true);
    expect(ok(summaryEditRequestSchema, { baseVersion: 1, output })).toBe(true);
    expect(ok(summaryEditRequestSchema, { baseVersion: 0, output })).toBe(false);
  });
  it('RedactionCounts is keyed by every kind', () => {
    expect(Object.keys(emptyRedactionCounts())).toEqual([...REDACTION_KINDS]);
    expect(ok(redactionCountsSchema, emptyRedactionCounts())).toBe(true);
    expect(ok(redactionCountsSchema, { ...emptyRedactionCounts(), name: 1 })).toBe(false);
    const { email: _e, ...missing } = emptyRedactionCounts();
    void _e;
    expect(ok(redactionCountsSchema, missing)).toBe(false);
  });
  it('stream-owned behaviour is a named stub until its stream fills it; luhnValid is the Phase A one', () => {
    // Filled by the ai stream (enterprise-redact.test.ts covers the rules).
    expect(redactText('a@b.co', newRedactionState())).toBe('[email-1]');
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
  });
});

describe('residency additions (section 6.2)', () => {
  const flow = { kind: 'ai_provider', name: 'Anthropic (Claude)', host: 'api.anthropic.com', leavesInfrastructure: true, leavesRegion: 'yes', dataSent: 'redacted session events', enabled: true, since: TS, enabledBy: 'Priya', acknowledgement: { scope: 'outside_region', by: 'Priya', at: TS } };
  it('categories, flows and the signature', () => {
    expect(ok(dataCategorySchema, { category: 'audit', stores: [{ kind: 'database', region: 'in-mum', detail: 'PostgreSQL of in-mum' }], retention: 'append-only, never deleted', count: 3, bytes: null })).toBe(true);
    expect(ok(dataCategorySchema, { category: 'audit', stores: [{ kind: 'tape', region: 'in-mum', detail: '' }], retention: '', count: null, bytes: null })).toBe(false);
    expect(ok(dataFlowSchema, flow)).toBe(true);
    expect(ok(dataFlowSchema, { ...flow, leavesRegion: 'maybe' })).toBe(false);
    expect(ok(residencySignatureSchema, { alg: 'Ed25519', domain: 'ia-residency-v1', kid: '0123456789abcdef', pub: 'A'.repeat(43), sig: 'B'.repeat(86), sha256: H, signedAt: TS })).toBe(true);
    expect(ok(residencySignatureSchema, { alg: 'Ed25519', domain: 'ia-checkpoint', kid: '0123456789abcdef', pub: 'A'.repeat(43), sig: 'B'.repeat(86), sha256: H, signedAt: TS })).toBe(false);
  });
  it('the report keeps parsing an A-D report, accepts the widened retention strings and the E fields', () => {
    const report = {
      org: { id: U, name: 'Acme', slug: 'acme', dataRegion: 'in-mum' },
      generatedAt: TS,
      servedBy: { region: 'in-mum', apiOrigin: 'https://x', nodeId: 'n' },
      storage: { driver: 'fs', bucket: '', prefix: 'in-mum/' },
      ice: { stunUrls: [], turnUrls: [], thirdPartyHosts: [] },
      counts: { users: 1, tokens: 0, sessions: 0, recordings: 0, recordingBytes: 0, auditEntries: 1 },
      chain: { length: 1, tail: H, lastVerifiedAt: null, lastVerifiedOk: null, lastAnchor: null },
      retention: {
        auditEntries: 'append-only, never deleted',
        piiInChain: 'hashed with a per-org pepper; pepper destruction is the erasure mechanism (Phase E)',
        recordings: 'until deleted by an org_admin (Phase B endpoint)',
      },
      statement: 'Data stays in India (Mumbai).',
    };
    expect(ok(residencyReportSchema, report)).toBe(true);
    expect(ok(residencyReportSchema, { ...report, retention: { ...report.retention, recordings: 'deleted 90 days after recording (org setting)' } })).toBe(true);
    expect(ok(residencyReportSchema, { ...report, retention: { ...report.retention, auditEntries: 'deleted sometimes' } })).toBe(false);
    expect(
      ok(residencyReportSchema, {
        ...report,
        dataFlows: [flow],
        subprocessors: ['Anthropic (Claude)'],
        activity30d: { summaries: 1, ticketPushes: 0, ssoLogins: 2 },
        sso: { protocol: null, enabled: false, required: false, verifiedDomains: [] },
        recorder: { enabled: false },
        erasure: { available: false, note: 'not implemented' },
      }),
    ).toBe(true);
    // Phase F section 5.7 widened `available` (the one non-additive residency change).
    expect(ok(residencyReportSchema, { ...report, erasure: { available: true, note: 'x' } })).toBe(true);
  });
});

describe('rest-core additions', () => {
  it('user and org carry the optional SSO / AI fields', () => {
    const user = { id: U, orgId: U2, email: 'a@b.co', name: 'A', role: 'org_admin', status: 'active', createdAt: TS, lastLoginAt: null };
    expect(ok(userSchema, user)).toBe(true);
    expect(ok(userSchema, { ...user, ssoBreakGlass: true, loginMethod: 'saml' })).toBe(true);
    expect(ok(userSchema, { ...user, loginMethod: 'magic' })).toBe(false);
    const org = { id: U, name: 'Acme', slug: 'acme', dataRegion: 'in-mum', planTier: 'p1_browser', branding: {}, createdAt: TS };
    expect(ok(orgSchema, org)).toBe(true);
    expect(ok(orgSchema, { ...org, ssoEnabled: true, ssoRequired: false, aiProvider: 'local' })).toBe(true);
    expect(ok(orgSchema, { ...org, aiProvider: 'openai' })).toBe(false);
  });
});

describe('audit actions (section 13.3)', () => {
  const SECRET_LIKE = /^(secret|clientSecret|password|token|accessToken|refreshToken|idToken|id_token|apiKey|apiToken|personalAccessToken|privateKey|credentials?|assertion|samlResponse|SAMLResponse|code|codeVerifier|nonce|body|text|note|transcript|output|ticket|message|email|url)$/; // `messages` (an int count) is the contract name of summary.transcript_received
  it('every E action is an audit action with exactly one actor and a strict schema', () => {
    expect(E_AUDIT_ACTIONS).toHaveLength(29);
    for (const a of E_AUDIT_ACTIONS) {
      expect(AUDIT_ACTIONS as readonly string[], a).toContain(a);
      expect(['user', 'system'], a).toContain(E_ACTION_ACTORS[a]);
      const schema = E_CHAIN_SCHEMAS[a] as unknown as z.ZodObject;
      expect(schema.safeParse({ __unknown: 1 }).success, a).toBe(false);
      expect(auditDataSchema(a)).toBe(E_CHAIN_SCHEMAS[a]);
    }
    expect(Object.keys(E_ACTION_ACTORS).sort()).toEqual([...E_AUDIT_ACTIONS].sort());
  });
  it('the two summary request actions have one actor each', () => {
    expect(E_ACTION_ACTORS['summary.requested']).toBe('user');
    expect(E_ACTION_ACTORS['summary.auto_requested']).toBe('system');
  });
  it('no chain schema accepts a key named like a secret, body or transcript', () => {
    for (const a of E_AUDIT_ACTIONS) {
      const shape = (E_CHAIN_SCHEMAS[a] as unknown as z.ZodObject).shape as Record<string, unknown>;
      for (const k of Object.keys(shape)) expect(SECRET_LIKE.test(k), `${a}.${k}`).toBe(false);
    }
  });
  it('sample entries parse, sanitise and refuse extras', () => {
    expect(auditDataSchema('auth.login').safeParse({ method: 'oidc' }).success).toBe(true);
    expect(auditDataSchema('auth.login').safeParse({ method: 'saml' }).success).toBe(true);
    expect(auditDataSchema('auth.sso_failed').safeParse({ protocol: 'oidc', cause: 'claim_mismatch', emailHash: null }).success).toBe(true);
    expect(auditDataSchema('auth.sso_failed').safeParse({ protocol: 'oidc', cause: 'claim_mismatch', emailHash: null, email: 'a@b.co' }).success).toBe(false);
    expect(auditDataSchema('user.provisioned').safeParse({ userId: U, emailHash: H, role: 'org_admin', tier: null, protocol: 'saml' }).success).toBe(false);
    expect(auditDataSchema('integration.secret_rotated').safeParse({ type: 'jira' }).success).toBe(false);
    expect(auditDataSchema('summary.generated').safeParse({
      summaryId: U, version: 1, provider: 'local', model: 'm', servedModel: 'm', inferenceGeo: 'in-mum', fallbackUsed: false, transcriptIncluded: false,
      inputSha256: H, sha256: H, redactions: emptyRedactionCounts(),
    }).success).toBe(true);
    expect(auditDataSchema('residency.report_issued').safeParse({ sha256: H, kid: '0123456789abcdef' }).success).toBe(true);
    const out = auditDataSchema('sso.domain_added').parse({ domainId: U, domain: 'example.com\u0007' });
    expect(out.domain).toBe('example.com');
  });
});

describe('PUBLIC_EMAIL_DOMAINS', () => {
  it('lists each domain once, normalised', () => {
    expect(new Set(PUBLIC_EMAIL_DOMAINS).size).toBe(PUBLIC_EMAIL_DOMAINS.length);
    for (const d of PUBLIC_EMAIL_DOMAINS) expect(normaliseDomain(d)).toBe(d);
  });
});
