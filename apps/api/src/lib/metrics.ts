/** prom-client metrics (contracts section 6): default registry metrics plus the five ia_* series. */
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

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
};

export function createMetrics(opts: { defaults?: boolean } = {}): Metrics {
  const registry = new Registry();
  if (opts.defaults ?? true) collectDefaultMetrics({ register: registry });
  const registers = [registry];
  return {
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
  };
}
