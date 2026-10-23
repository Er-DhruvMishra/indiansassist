/**
 * Worker keepalive (section 9.2): a 30 s alarm while a session exists (the 25 s server ping keeps the worker alive
 * between alarms). The alarm handler also restores state after a worker restart.
 */
import { KEEPALIVE_ALARM } from '../shared/constants';
import { ext } from '../shared/api';

export async function startKeepalive(): Promise<void> {
  const existing = await ext().alarms.get(KEEPALIVE_ALARM);
  if (!existing) await ext().alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
}

export async function stopKeepalive(): Promise<void> {
  await ext().alarms.clear(KEEPALIVE_ALARM);
}
