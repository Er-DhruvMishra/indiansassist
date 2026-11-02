/**
 * Phase E section 5.2 / 15.4: the org AI policy. Capabilities per region, `409 ai_provider_unavailable`, the exact
 * acknowledgement for each scope, clearing it when the org moves away from `anthropic`, RBAC, and the chain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_ACK_TEXT_VERSION, REGION_LABELS, aiAckText } from '@indiansassist/shared';
import { capabilitiesFor, requiredAckScope } from '../src/ai/policy.js';
import { addMember, call, makeApp, signup, type Account, type TestApp } from './helpers.js';
import { FakeSummaryProvider, chainOf, useProviders } from './ai-kit.js';

let t: TestApp;
let admin: Account;
let tech: Account;
let observer: Account;
let auditor: Account;

beforeAll(async () => {
  t = await makeApp();
  admin = await signup(t.app, { orgName: 'Acme IT' });
  tech = await addMember(t.app, admin, 'technician');
  observer = await addMember(t.app, admin, 'observer');
  auditor = await addMember(t.app, admin, 'auditor');
});
afterAll(async () => t.close());

const patch = (acc: Account, body: unknown) => call(t.app, '/api/v1/orgs/current/ai-policy', { method: 'PATCH', cookie: acc.cookie, body });
const ackText = (scope: 'in_geo' | 'outside_region', orgName = 'Acme IT', region: keyof typeof REGION_LABELS = 'in-mum') => aiAckText(scope, orgName, REGION_LABELS[region]);

describe('capabilities (5.2b)', () => {
  it('reports nothing when the node serves no provider', async () => {
    useProviders(t, {});
    const res = await call(t.app, '/api/v1/ai/capabilities', { cookie: observer.cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ region: 'in-mum', local: false, anthropic: { available: false, inferenceGeo: null, ackScope: null } });
  });
  it('names the geography and the scope per region', () => {
    const ctx = { summaryProviders: () => ({ local: new FakeSummaryProvider('local'), anthropic: new FakeSummaryProvider('anthropic') }) };
    expect(capabilitiesFor(ctx, 'us-east')).toEqual({ region: 'us-east', local: true, anthropic: { available: true, inferenceGeo: 'us', ackScope: 'in_geo' } });
    expect(capabilitiesFor(ctx, 'in-mum')).toEqual({ region: 'in-mum', local: true, anthropic: { available: true, inferenceGeo: null, ackScope: 'outside_region' } });
    expect(capabilitiesFor(ctx, 'eu-fra').anthropic.ackScope).toBe('outside_region');
    expect(requiredAckScope('us-east')).toBe('in_geo');
  });
  it('is readable by every role and needs a session', async () => {
    for (const acc of [tech, auditor, observer]) expect((await call(t.app, '/api/v1/ai/capabilities', { cookie: acc.cookie })).statusCode).toBe(200);
    expect((await call(t.app, '/api/v1/ai/capabilities')).statusCode).toBe(401);
  });
});

describe('policy (5.2, 5.9)', () => {
  it('defaults to none for a new org and is readable by every role', async () => {
    for (const acc of [admin, tech, observer, auditor]) {
      const res = await call(t.app, '/api/v1/orgs/current/ai-policy', { cookie: acc.cookie });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ provider: 'none', autoSummarize: false, includeTranscript: false, anthropicAck: null });
    }
  });

  it('only an org_admin may change it', async () => {
    useProviders(t, { local: new FakeSummaryProvider('local') });
    for (const acc of [tech, observer, auditor]) expect((await patch(acc, { provider: 'local' })).statusCode).toBe(403);
  });

  it('refuses a provider this node cannot serve for the region', async () => {
    useProviders(t, {});
    const res = await patch(admin, { provider: 'local' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ai_provider_unavailable');
    const res2 = await patch(admin, { provider: 'anthropic', acknowledge: { scope: 'outside_region', text: ackText('outside_region') } });
    expect(res2.json().error.code).toBe('ai_provider_unavailable');
  });

  it('accepts local and chains the change', async () => {
    useProviders(t, { local: new FakeSummaryProvider('local'), anthropic: new FakeSummaryProvider('anthropic') });
    const res = await patch(admin, { provider: 'local', autoSummarize: true, includeTranscript: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ provider: 'local', autoSummarize: true, includeTranscript: true, anthropicAck: null });
    const last = (await chainOf(t, admin.org.id)).filter((r) => r.action === 'ai.policy_updated').at(-1)!;
    expect(last.actorType).toBe('user');
    expect(last.sessionId).toBeNull();
    expect(last.data).toEqual({ provider: 'local', autoSummarize: true, includeTranscript: true, ackScope: null, ackTextVersion: null });
  });

  it('anthropic needs the exact acknowledgement for the region scope (outside_region in India)', async () => {
    const without = await patch(admin, { provider: 'anthropic' });
    expect(without.statusCode).toBe(400);
    expect(without.json().error.code).toBe('ai_ack_required');
    const wrongScope = await patch(admin, { provider: 'anthropic', acknowledge: { scope: 'in_geo', text: ackText('in_geo') } });
    expect(wrongScope.json().error.code).toBe('ai_ack_required');
    const wrongText = await patch(admin, { provider: 'anthropic', acknowledge: { scope: 'outside_region', text: ackText('outside_region').replace('Acme IT', 'Acme') } });
    expect(wrongText.json().error.code).toBe('ai_ack_required');
    const trailing = await patch(admin, { provider: 'anthropic', acknowledge: { scope: 'outside_region', text: `${ackText('outside_region')} ` } });
    expect(trailing.json().error.code).toBe('ai_ack_required');
    // Nothing changed on a refusal.
    expect((await call(t.app, '/api/v1/orgs/current/ai-policy', { cookie: admin.cookie })).json().provider).toBe('local');

    const ok = await patch(admin, { provider: 'anthropic', acknowledge: { scope: 'outside_region', text: ackText('outside_region') } });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.provider).toBe('anthropic');
    expect(body.anthropicAck).toMatchObject({ scope: 'outside_region', textVersion: AI_ACK_TEXT_VERSION, by: { id: admin.user.id, name: admin.user.name } });
    const last = (await chainOf(t, admin.org.id)).filter((r) => r.action === 'ai.policy_updated').at(-1)!;
    expect(last.data).toMatchObject({ provider: 'anthropic', ackScope: 'outside_region', ackTextVersion: 'ai-ack-v2' });
    // Other changes while on anthropic keep the acknowledgement without repeating it.
    const tweak = await patch(admin, { autoSummarize: false });
    expect(tweak.statusCode).toBe(200);
    expect(tweak.json().anthropicAck.scope).toBe('outside_region');
  });

  it('moving away clears the acknowledgement and coming back needs it again', async () => {
    const away = await patch(admin, { provider: 'local' });
    expect(away.json().anthropicAck).toBeNull();
    const back = await patch(admin, { provider: 'anthropic' });
    expect(back.json().error.code).toBe('ai_ack_required');
    const none = await patch(admin, { provider: 'none' });
    expect(none.json()).toMatchObject({ provider: 'none', anthropicAck: null });
  });

  it('a us-east org uses in_geo, whose text promises the United States', async () => {
    const us = await signup(t.app, { orgName: 'US Desk', region: 'us-east' });
    const res = await call(t.app, '/api/v1/ai/capabilities', { cookie: us.cookie });
    expect(res.json().anthropic).toEqual({ available: true, inferenceGeo: 'us', ackScope: 'in_geo' });
    const wrong = await patch(us, { provider: 'anthropic', acknowledge: { scope: 'outside_region', text: ackText('outside_region', 'US Desk', 'us-east') } });
    expect(wrong.json().error.code).toBe('ai_ack_required');
    const ok = await patch(us, { provider: 'anthropic', acknowledge: { scope: 'in_geo', text: ackText('in_geo', 'US Desk', 'us-east') } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().anthropicAck.scope).toBe('in_geo');
  });

  it('validates the body', async () => {
    expect((await patch(admin, { provider: 'gpt' })).json().error.code).toBe('validation_failed');
    expect((await patch(admin, { extra: true })).json().error.code).toBe('validation_failed');
  });
});
