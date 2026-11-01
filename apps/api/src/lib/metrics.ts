/**
 * prom-client metrics (contracts section 6): default registry metrics, the A/B/C `ia_*` series and the seven Phase D
 * fleet series of `docs/specs/phase-d-contracts.md` section 13.5 (`ia_devices_connected`, `ia_device_hello_total`,
 * `ia_device_heartbeat_lag_seconds`, `ia_wake_attempts_total`, `ia_device_actions_total`, `ia_tamper_alerts_total`,
 * `ia_receipts_sent_total`). Every labelled fleet series is zero-initialised over its label values at boot, so a
 * dashboard or alert never has to wait for the first event for the series to exist, and the label names of the
 * contract are always visible on `/metrics`.
 */
import {
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
  };
  for (const result of DEVICE_HELLO_RESULTS) m.deviceHello.inc({ result }, 0);
  for (const method of WAKE_METRIC_METHODS) for (const result of WAKE_METRIC_RESULTS) m.wakeAttempts.inc({ method, result }, 0);
  for (const kind of DEVICE_ACTION_KINDS) for (const state of DEVICE_ACTION_STATES) m.deviceActions.inc({ kind, state }, 0);
  for (const cause of TAMPER_METRIC_CAUSES) m.tamperAlerts.inc({ cause }, 0);
  for (const channel of ['device', 'email'] as const) for (const delivered of ['true', 'false'] as const) m.receiptsSent.inc({ channel, delivered }, 0);
  return m;
}

/** Records one device action transition (section 9.2); every call site is a successful state change. */
export function countDeviceAction(m: Metrics, kind: DeviceActionKind, state: DeviceActionState): void {
  m.deviceActions.inc({ kind, state });
}
