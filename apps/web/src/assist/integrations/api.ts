/** REST calls of the ticketing integrations (docs/specs/phase-e-contracts.md section 4.7). */
import {
  integrationSchema,
  integrationsAvailableSchema,
  integrationTestReplySchema,
  sessionSummaryListSchema,
  sessionTicketsSchema,
  ticketPushReplySchema,
  webhookCreatedReplySchema,
  webhookSecretReplySchema,
  type Integration,
  type IntegrationType,
  type TicketFailureCause,
  type TicketPush,
  type TicketPushRequest,
} from '@indiansassist/shared';
import { z } from 'zod';
import { request } from '../../lib/api';

const listSchema = z.strictObject({ items: z.array(integrationSchema) });

export type IntegrationTestReply = z.infer<typeof integrationTestReplySchema>;
export type SummaryList = z.infer<typeof sessionSummaryListSchema>;

export const integrationsApi = {
  list: () => request<{ items: Integration[] }>('GET', '/integrations', { schema: listSchema }),
  available: () => request<{ items: { type: IntegrationType; enabled: true }[] }>('GET', '/integrations/available', { schema: integrationsAvailableSchema }),
  /** `PUT /integrations/:type`; a new webhook answers `{ integration, secret }` (the secret shown once). */
  save: async (type: IntegrationType, body: { enabled: boolean; config: Record<string, unknown>; credentials?: Record<string, unknown> | null }) => {
    const r = await request<unknown>('PUT', `/integrations/${type}`, { body });
    const created = webhookCreatedReplySchema.safeParse(r);
    if (created.success) return { integration: created.data.integration, secret: created.data.secret };
    return { integration: r as Integration, secret: null as string | null };
  },
  test: (type: IntegrationType) => request<IntegrationTestReply>('POST', `/integrations/${type}/test`, { body: {}, schema: integrationTestReplySchema }),
  remove: (type: IntegrationType) => request<void>('DELETE', `/integrations/${type}`),
  rotateWebhookSecret: () => request<{ secret: string }>('POST', '/integrations/webhook/rotate-secret', { body: {}, schema: webhookSecretReplySchema }),
  push: (type: IntegrationType, body: TicketPushRequest) => request<{ push: TicketPush }>('POST', `/integrations/${type}/ticket`, { body, schema: ticketPushReplySchema }),
  sessionPushes: (sessionId: string) => request<{ items: TicketPush[] }>('GET', `/sessions/${sessionId}/tickets`, { schema: sessionTicketsSchema }),
  retry: (pushId: string) => request<{ push: TicketPush }>('POST', `/integrations/pushes/${pushId}/retry`, { body: {}, schema: ticketPushReplySchema }),
  /** The session's summary versions (ai stream, section 5.9), for the version picker. */
  summaries: (sessionId: string) => request<SummaryList>('GET', `/sessions/${sessionId}/summary`, { schema: sessionSummaryListSchema }),
};

export const TYPE_LABELS: Record<IntegrationType, string> = {
  zoho_desk: 'Zoho Desk',
  servicenow: 'ServiceNow',
  jira: 'Jira',
  freshdesk: 'Freshdesk',
  webhook: 'Webhook',
};

/** Failure causes in plain words (section 11: states in words, never colour alone). */
export const CAUSE_WORDS: Record<TicketFailureCause, string> = {
  auth: 'the credentials were refused',
  forbidden: 'the account may not do this',
  not_found: 'not found in the ticketing system',
  validation: 'the ticketing system refused the content',
  rate_limited: 'the ticketing system asked us to slow down',
  unreachable: 'the ticketing system could not be reached',
  timeout: 'no answer in time (the ticket may have been created)',
  upstream_error: 'the ticketing system had an error',
  misconfigured: 'the integration is not set up correctly',
  egress_refused: 'the address may not be reached from this server',
};

/** Rule 4.4e: before retrying these the console warns that the ticket may already exist. */
export function isAmbiguous(cause: TicketFailureCause | null | undefined): boolean {
  return cause === 'timeout' || cause === 'upstream_error';
}
