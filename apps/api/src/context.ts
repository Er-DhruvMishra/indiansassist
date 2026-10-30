/** Everything a route, service or signaling handler needs, built once per app (buildApp). */
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@indiansassist/db';
import type { AuthProvider } from './adapters/auth-provider.js';
import type { Presence } from './adapters/presence.js';
import type { ObjectStorage } from './adapters/storage.js';
import type { Config } from './config.js';
import type { KeySet } from './lib/keys.js';
import type { Metrics } from './lib/metrics.js';
import type { Limiter, ShortCodeBudget } from './limiter.js';
import type { AgentDist } from './services/agent-dist.js';
import type { SignalHub } from './signal/hub.js';

/** Signaling and session timers (contracts sections 7.2, 7.5); tests shorten them. */
export type Timing = {
  helloTimeoutMs: number;
  pingIntervalMs: number;
  idleTimeoutMs: number;
  knockTimeoutMs: number;
  consentTimeoutMs: number;
  graceMs: number;
  /** Signaling housekeeping tick (hello / heartbeat checks). */
  tickMs: number;
  /** How long an ended session stays in the live registry so `desk.event` is accepted (`ended_at + 60 s`). */
  eventGraceMs: number;
  /** How often a live socket's cookie principal is re-read from auth_session / user (section 7.2). */
  authRecheckMs: number;
  /** Phase A.2: how long a recorder has to `recorder.join` an assignment. */
  recorderJoinTimeoutMs: number;
};

export const DEFAULT_TIMING: Timing = {
  helloTimeoutMs: 5_000,
  pingIntervalMs: 25_000,
  idleTimeoutMs: 60_000,
  knockTimeoutMs: 120_000,
  consentTimeoutMs: 180_000,
  graceMs: 30_000,
  tickMs: 1_000,
  eventGraceMs: 60_000,
  authRecheckMs: 30_000,
  recorderJoinTimeoutMs: 10_000,
};

export type AppContext = {
  config: Config;
  db: Db;
  storage: ObjectStorage;
  presence: Presence;
  limiter: Limiter;
  shortCodes: ShortCodeBudget;
  keys: KeySet;
  metrics: Metrics;
  presignKey: Buffer;
  authProvider: AuthProvider;
  log: FastifyBaseLogger;
  timing: Timing;
  version: string;
  /** Phase C section 2.2: agent builds served by this node. */
  agentDist: AgentDist;
  /** Set right after construction; REST routes push WS events through it. */
  hub: SignalHub;
};
