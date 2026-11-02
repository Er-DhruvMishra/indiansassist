/**
 * prom-client metrics (contracts section 6): default registry metrics, the A/B/C `ia_*` series and the seven Phase D
 * fleet series of `docs/specs/phase-d-contracts.md` section 13.5 (`ia_devices_connected`, `ia_device_hello_total`,
 * `ia_device_heartbeat_lag_seconds`, `ia_wake_attempts_total`, `ia_device_actions_total`, `ia_tamper_alerts_total`,
 * `ia_receipts_sent_total`). Every labelled fleet series is zero-initialised over its label values at boot, so a
 * dashboard or alert never has to wait for the first event for the series to exist, and the label names of the
 * contract are always visible on `/metrics`. Phase E (docs/specs/phase-e-contracts.md section 11) adds six series the
 * foundation registers zero-initialised and the streams increment: `ia_sso_logins_total`, `ia_egress_requests_total`,
 * `ia_ticket_pushes_total`, `ia_summaries_total`, `ia_summary_seconds`, `ia_redactions_total`. Phase F
 * (docs/specs/phase-f-contracts.md section 12) adds four, the same way: `ia_mail_sent_total`,
 * `ia_password_resets_total`, `ia_erasures_total`, `ia_camera_sessions_total`.
 */
import {
  MAIL_KINDS,
  EGRESS_PURPOSES,
  INTEGRATION_TYPES,
  REDACTION_KINDS,
  SSO_ERROR_CODES,
  SSO_PROTOCOLS,
  SUMMARY_FAIL_CAUSES,
  DEVICE_ACTION_KINDS,
  DEVICE_ACTION_STATES,
  TAMPER_CAUSES,
  WAKE_FAIL_CAUSES,
  type DeviceActionKind,
  type DeviceActionState,
  type TamperCause,
  type WakeFailCause,
} from '@indiansassist/shared';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Section 3.4 `device.hello` outcomes, as the `result` label of `ia_device_hello_total`. */
export const DEVICE_HELLO_RESULTS = ['ok', 'unauthenticated', 'disabled', 'region_mismatch', 'rate_limited'] as const;
export type DeviceHelloResult = (typeof DEVICE_HELLO_RESULTS)[number];

/** The `method` label of `ia_wake_attempts_total`: the resolved path, never the `auto` request (section 8.1). */
export const WAKE_METRIC_METHODS = ['wol', 'amt'] as const;
/** The `result` label of `ia_wake_attempts_total`: the terminal state of the attempt (rule 8.3 / W3). */
export const WAKE_METRIC_RESULTS = ['woke', ...WAKE_FAIL_CAUSES] as const;
export type WakeMetricResult = 'woke' | WakeFailCause;

/** The `cause` label of `ia_tamper_alerts_total`: a device-signed cause (rule 10.5) or the server's `suspected`. */
export const TAMPER_METRIC_CAUSES = [...TAMPER_CAUSES, 'suspected'] as const;
export type TamperMetricCause = TamperCause | 'suspected';

/** Phase E section 11: `ia_sso_logins_total.result` is `ok` or an SSO_ERROR_CODES value. */
export const SSO_LOGIN_RESULTS = ['ok', ...SSO_ERROR_CODES] as const;
/** Phase E section 11: `ia_egress_requests_total.result`. */
export const EGRESS_RESULTS = ['ok', 'refused', 'timeout', 'error'] as const;
export type EgressResult = (typeof EGRESS_RESULTS)[number];
/** Phase E section 11: `ia_ticket_pushes_total.state` counts the terminal and `retrying` transitions. */
export const TICKET_PUSH_METRIC_STATES = ['delivered', 'retrying', 'failed'] as const;
/** Phase E section 11: the providers that generate (a `none` policy generates nothing). */
export const SUMMARY_METRIC_PROVIDERS = ['local', 'anthropic'] as const;
/** Phase E section 11: `ia_summaries_total.result` is `ready` or a SUMMARY_FAIL_CAUSES value. */
export const SUMMARY_METRIC_RESULTS = ['ready', ...SUMMARY_FAIL_CAUSES] as const;
const SUMMARY_SECONDS_BUCKETS = [1, 2, 5, 10, 20, 40, 80, 160];

/** Phase F section 4.1e: `ia_mail_sent_total.result`. */
export const MAIL_SENT_RESULTS = ['sent', 'failed', 'no_mailer'] as const;
export type MailSentResult = (typeof MAIL_SENT_RESULTS)[number];
/** Phase F section 12: `ia_password_resets_total.result`. */
export const PASSWORD_RESET_RESULTS = ['mailed', 'sso_notice', 'throttled', 'send_failed', 'no_mailer', 'unknown', 'confirmed', 'invalid'] as const;
export type PasswordResetResult = (typeof PASSWORD_RESET_RESULTS)[number];
/** Phase F section 12: `ia_erasures_total.state` counts the terminal transitions. */
export const ERASURE_METRIC_STATES = ['completed', 'cancelled', 'expired'] as const;
/** Phase F section 6.7: the tiers a camera can join and `ia_camera_sessions_total.result`. */
export const CAMERA_METRIC_TIERS = ['p1_browser', 'p3_portable', 'p4_installed'] as const;
export const CAMERA_METRIC_RESULTS = ['live', 'declined', 'no_camera', 'expired', 'error'] as const;

/** Section 13.5: a heartbeat is due every 30 s +- 5 s, so the interesting mass is 25-35 s and the tail is a stall. */
const HEARTBEAT_LAG_BUCKETS = [15, 25, 30, 35, 45, 60, 90, 120, 300, 900];

export type Metrics = {
  registry: Registry;
  wsConnections: Gauge;
  sessionsActive: Gauge;
  auditEntries: Counter;
  shortCodeMisses: Counter;
  rateLimited: Counter;
  /** Phase A.2 section 12. */
  recorderConnections: Gauge;
  recorderSessions: Gauge;
  recorderAssignFailures: Counter;
  /** Phase D section 13.5: helloed `/signal/device` sockets held by this node. */
  devicesConnected: Gauge;
  deviceHello: Counter<'result'>;
  /** Seconds between a device's previous check-in and its heartbeat. */
  deviceHeartbeatLag: Histogram;
  wakeAttempts: Counter<'method' | 'result'>;
  deviceActions: Counter<'kind' | 'state'>;
  tamperAlerts: Counter<'cause'>;
  receiptsSent: Counter<'channel' | 'delivered'>;
  /** Phase E section 11. */
  ssoLogins: Counter<'protocol' | 'result'>;
  egressRequests: Counter<'purpose' | 'result'>;
  ticketPushes: Counter<'type' | 'state'>;
  summaries: Counter<'provider' | 'result'>;
  summarySeconds: Histogram<'provider'>;
  redactions: Counter<'kind'>;
  /** Phase F section 12. */
  mailSent: Counter<'kind' | 'result'>;
  passwordResets: Counter<'result'>;
  erasures: Counter<'state'>;
  cameraSessions: Counter<'tier' | 'result'>;
};

export function createMetrics(opts: { defaults?: boolean } = {}): Metrics {
  const registry = new Registry();
  if (opts.defaults ?? true) collectDefaultMetrics({ register: registry });
  const registers = [registry];
  const m: Metrics = {
    registry,
    wsConnections: new Gauge({ name: 'ia_ws_connections', help: 'Open /signal sockets', registers }),
    sessionsActive: new Gauge({ name: 'ia_sessions_active', help: 'Sessions in state active on this node', registers }),
    auditEntries: new Counter({ name: 'ia_audit_entries_total', help: 'Audit entries appended', registers }),
    shortCodeMisses: new Counter({ name: 'ia_short_code_misses_total', help: 'Short code lookup misses', registers }),
    rateLimited: new Counter({ name: 'ia_rate_limited_total', help: 'Requests or frames rejected by a limit', registers }),
    recorderConnections: new Gauge({ name: 'ia_recorder_connections', help: 'Helloed recorder sockets', registers }),
    recorderSessions: new Gauge({ name: 'ia_recorder_sessions', help: 'Sessions with a joined recorder', registers }),
    recorderAssignFailures: new Counter({
      name: 'ia_recorder_assign_failures_total',
      help: 'Sessions that needed a server recorder and got none',
      registers,
    }),
    devicesConnected: new Gauge({ name: 'ia_devices_connected', help: 'Authenticated /signal/device sockets on this node', registers }),
    deviceHello: new Counter({ name: 'ia_device_hello_total', help: 'device.hello attempts by outcome', labelNames: ['result'], registers }),
    deviceHeartbeatLag: new Histogram({
      name: 'ia_device_heartbeat_lag_seconds',
      help: 'Seconds between a device check-in and the heartbeat that followed it',
      buckets: HEARTBEAT_LAG_BUCKETS,
      registers,
    }),
    wakeAttempts: new Counter({
      name: 'ia_wake_attempts_total',
      help: 'Wake attempts by resolved method and terminal result (woke or the honest failure cause)',
      labelNames: ['method', 'result'],
      registers,
    }),
    deviceActions: new Counter({
      name: 'ia_device_actions_total',
      help: 'Device action state transitions by kind and the state entered',
      labelNames: ['kind', 'state'],
      registers,
    }),
    tamperAlerts: new Counter({ name: 'ia_tamper_alerts_total', help: 'Tamper alerts by cause', labelNames: ['cause'], registers }),
    receiptsSent: new Counter({
      name: 'ia_receipts_sent_total',
      help: 'Consent receipt deliveries by channel and whether the channel delivered',
      labelNames: ['channel', 'delivered'],
      registers,
    }),
    ssoLogins: new Counter({
      name: 'ia_sso_logins_total',
      help: 'SSO sign-ins by protocol and result (ok or the SSO error code)',
      labelNames: ['protocol', 'result'],
      registers,
    }),
    egressRequests: new Counter({
      name: 'ia_egress_requests_total',
      help: 'Outbound calls to org-supplied URLs through the egress guard, by purpose and result',
      labelNames: ['purpose', 'result'],
      registers,
    }),
    ticketPushes: new Counter({
      name: 'ia_ticket_pushes_total',
      help: 'Ticket push transitions (delivered, retrying, failed) by integration type',
      labelNames: ['type', 'state'],
      registers,
    }),
    summaries: new Counter({
      name: 'ia_summaries_total',
      help: 'Summary generation outcomes by provider (ready or the failure cause)',
      labelNames: ['provider', 'result'],
      registers,
    }),
    summarySeconds: new Histogram({
      name: 'ia_summary_seconds',
      help: 'Seconds one summary generation attempt took, by provider',
      labelNames: ['provider'],
      buckets: SUMMARY_SECONDS_BUCKETS,
      registers,
    }),
    redactions: new Counter({ name: 'ia_redactions_total', help: 'Redaction placeholders inserted, by kind', labelNames: ['kind'], registers }),
    mailSent: new Counter({ name: 'ia_mail_sent_total', help: 'Mails by kind and outcome', labelNames: ['kind', 'result'], registers }),
    passwordResets: new Counter({
      name: 'ia_password_resets_total',
      help: 'Password reset requests and confirmations by outcome',
      labelNames: ['result'],
      registers,
    }),
    erasures: new Counter({ name: 'ia_erasures_total', help: 'Org erasures reaching a terminal state', labelNames: ['state'], registers }),
    cameraSessions: new Counter({
      name: 'ia_camera_sessions_total',
      help: 'Phone camera sessions by tier and outcome',
      labelNames: ['tier', 'result'],
      registers,
    }),
  };
  for (const result of DEVICE_HELLO_RESULTS) m.deviceHello.inc({ result }, 0);
  for (const method of WAKE_METRIC_METHODS) for (const result of WAKE_METRIC_RESULTS) m.wakeAttempts.inc({ method, result }, 0);
  for (const kind of DEVICE_ACTION_KINDS) for (const state of DEVICE_ACTION_STATES) m.deviceActions.inc({ kind, state }, 0);
  for (const cause of TAMPER_METRIC_CAUSES) m.tamperAlerts.inc({ cause }, 0);
  for (const channel of ['device', 'email'] as const) for (const delivered of ['true', 'false'] as const) m.receiptsSent.inc({ channel, delivered }, 0);
  // Phase E section 11: every labelled series exists from boot.
  for (const protocol of SSO_PROTOCOLS) for (const result of SSO_LOGIN_RESULTS) m.ssoLogins.inc({ protocol, result }, 0);
  for (const purpose of EGRESS_PURPOSES) for (const result of EGRESS_RESULTS) m.egressRequests.inc({ purpose, result }, 0);
  for (const type of INTEGRATION_TYPES) for (const state of TICKET_PUSH_METRIC_STATES) m.ticketPushes.inc({ type, state }, 0);
  for (const provider of SUMMARY_METRIC_PROVIDERS) {
    for (const result of SUMMARY_METRIC_RESULTS) m.summaries.inc({ provider, result }, 0);
    m.summarySeconds.zero({ provider });
  }
  for (const kind of REDACTION_KINDS) m.redactions.inc({ kind }, 0);
  // Phase F section 12: likewise.
  for (const kind of MAIL_KINDS) for (const result of MAIL_SENT_RESULTS) m.mailSent.inc({ kind, result }, 0);
  for (const result of PASSWORD_RESET_RESULTS) m.passwordResets.inc({ result }, 0);
  for (const state of ERASURE_METRIC_STATES) m.erasures.inc({ state }, 0);
  for (const tier of CAMERA_METRIC_TIERS) for (const result of CAMERA_METRIC_RESULTS) m.cameraSessions.inc({ tier, result }, 0);
  return m;
}

/** Records one device action transition (section 9.2); every call site is a successful state change. */
export function countDeviceAction(m: Metrics, kind: DeviceActionKind, state: DeviceActionState): void {
  m.deviceActions.inc({ kind, state });
}
