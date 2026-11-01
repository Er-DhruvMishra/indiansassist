/**
 * Phase D sweeper pass (runs inside the lease-holding node's 10 s sweep): device actions past `expires_at`, queued
 * actions of devices online here whose policy window opened, unconfirmed wakes (`no_confirm`), SOL sessions past
 * `amtSolMaxMinutes`, and devices silent past `tamperSilentGraceSec` (`tamper.suspected`).
 */
import type { AppContext } from '../context.js';
import { expireActions, redispatchQueues } from './actions.js';
import { sweepSilentDevices } from './tamper.js';
import { sweepWakes } from './wake.js';

export async function fleetSweep(ctx: AppContext): Promise<void> {
  await expireActions(ctx);
  await redispatchQueues(ctx);
  await sweepWakes(ctx);
  await sweepSilentDevices(ctx);
}
