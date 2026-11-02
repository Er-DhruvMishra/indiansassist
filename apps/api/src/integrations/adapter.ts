/**
 * The ticketing adapter seam (docs/specs/phase-e-contracts.md section 4.1). One adapter per `IntegrationType`; adding
 * a PSA tool is one enum value, a config and a credential schema, one adapter and one fake server. Adapters never
 * throw for an upstream outcome: every call ends in an `AdapterResult` whose failure carries a cause from the closed
 * `TICKET_FAILURE_CAUSES` set (E4). Every upstream request goes through `AdapterCtx.fetch` (the egress guard).
 */
import {
  ZOHO_DATA_CENTERS,
  type IntegrationConfigOf,
  type IntegrationCredentialsOf,
  type IntegrationType,
  type TicketContent,
  type TicketFailure,
} from '@indiansassist/shared';
import type { EgressFetch } from '../lib/egress.js';
import { createFreshdeskAdapter } from './adapters/freshdesk.js';
import { createJiraAdapter } from './adapters/jira.js';
import { createServicenowAdapter } from './adapters/servicenow.js';
import { createWebhookAdapter } from './adapters/webhook.js';
import { createZohoDeskAdapter } from './adapters/zoho-desk.js';

export type { TicketFailure };

/** Upstream ids and links of a created ticket or an appended note. */
/** `externalId` is null when the far end names no id (a webhook receiver may not); section 4.1. */
export type TicketRef = { externalId: string | null; externalUrl: string | null };

export interface TicketingAdapter<T extends IntegrationType = IntegrationType> {
  readonly type: T;
  /** A cheap authenticated read proving the configuration and credentials work. */
  test(c: AdapterCtx<T>): Promise<AdapterResult<{ account: string | null }>>;
  /** Creates a new ticket. */
  create(c: AdapterCtx<T>, ticket: TicketContent): Promise<AdapterResult<TicketRef>>;
  /** Adds a private or internal note to an existing ticket. */
  append(c: AdapterCtx<T>, externalId: string, ticket: TicketContent): Promise<AdapterResult<TicketRef>>;
}

export type AdapterCtx<T extends IntegrationType> = {
  orgId: string;
  /** INTEGRATION_CONFIG_SCHEMAS[T], parsed (for `webhook` the written form `{ url }`, opened from the sealed value). */
  config: IntegrationConfigOf<T>;
  /** INTEGRATION_CREDENTIAL_SCHEMAS[T], opened for this call only. */
  credentials: IntegrationCredentialsOf<T>;
  /** The egress guard; adapters pass purpose `ticketing` (or `webhook`). */
  fetch: EgressFetch;
  /** Webhook headers; the others ignore it. */
  delivery: { pushId: string; attempt: number };
  now: () => Date;
  /**
   * Epoch ms by which the whole attempt must end (section 4.4a: one attempt is bounded by 15 s, also when an adapter
   * makes two calls, as Zoho's token refresh does). Each upstream call's timeout is what is left of it.
   */
  deadline: number;
};

export type AdapterResult<R> = { ok: true; value: R; status: number } | { ok: false; failure: TicketFailure };

/** The timeout of one attempt (section 4.4a: 15 s); tests shorten it to exercise a hung upstream quickly. */
export const attemptTiming = { timeoutMs: 15_000 };

/** One adapter per type (section 4.1). The Zoho adapter calls only the hosts of `ZOHO_DATA_CENTERS`. */
export const INTEGRATION_ADAPTERS: { [T in IntegrationType]: TicketingAdapter<T> } = {
  zoho_desk: createZohoDeskAdapter({ dataCenters: ZOHO_DATA_CENTERS }),
  servicenow: createServicenowAdapter(),
  jira: createJiraAdapter(),
  freshdesk: createFreshdeskAdapter(),
  webhook: createWebhookAdapter(),
};
