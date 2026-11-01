/**
 * /app/sessions/:id: decides between the live console (the caller is the accepting Assist), the knock
 * panel (still `knocked`), a read-only summary (someone else's live session, or a read-only role) and
 * the ended view. On reload the live console re-attaches with `assist.resume`.
 */
import { Link, useParams } from 'react-router';
import { isNativeTier } from '@indiansassist/shared';
import { useAuth } from '../../auth/AuthContext';
import { can } from '../../auth/permissions';
import { Alert, Badge, Card, PageHeader, Spinner } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { usePageTitle } from '../../hooks/usePageTitle';
import { errorMessage } from '../../lib/api';
import { sessionsApi } from '../../lib/endpoints';
import { devicesApi } from '../../lib/fleetApi';
import { fmtDateTime, humanise } from '../../lib/format';
import { StateBadge } from '../SessionsPage';
import { useAssistSignal } from '../signal/AssistSignalProvider';
import { KnockPanel } from '../signal/KnockPanel';
import { EndedView } from './EndedView';
import { LiveConsole } from './LiveConsole';
import { MirrorLiveConsole } from './mirror/MirrorConsole';
import { AgentConsole } from './agent/AgentConsole';
import type { UnattendedSessionInfo } from './agent/UnattendedBanner';

export function ConsolePage() {
  usePageTitle('Session console');
  const { id = '' } = useParams();
  const { me } = useAuth();
  const signal = useAssistSignal();
  const cached = signal?.takeCreated(id);
  const detail = useAsync(() => sessionsApi.get(id), [id]);
  const d = detail.data;

  // Phase D section 13.4: a P4 session names its device, so the console can say whether it is unattended and show the
  // technician-visible policy state. The effective policy comes from `GET /devices/:id` (section 7.2).
  const deviceId = cached?.device?.id ?? d?.deviceId ?? null;
  const fleetRead = can(me?.user.role, 'fleet.read');
  const devicePolicy = useAsync(
    () => (deviceId && fleetRead ? devicesApi.get(deviceId).then((x) => x.policy) : Promise.resolve(null)),
    [deviceId, fleetRead],
  );
  const unattended = cached?.unattended ?? d?.unattended ?? null;
  const device: UnattendedSessionInfo | undefined = deviceId
    ? {
        unattended: unattended === true,
        deviceName: cached?.device?.name ?? d?.deskLabel ?? 'this device',
        policy: devicePolicy.data ?? null,
      }
    : undefined;

  // Section 13.4: the kind of a device session is never left implicit, live, read-only or ended.
  const kindBadge = deviceId ? (
    <Badge tone={unattended === true ? 'amber' : 'blue'}>{unattended === true ? 'Unattended device session' : 'Attended device session'}</Badge>
  ) : null;

  const back = (
    <Link to="/app/sessions" className="text-sm font-medium text-teal-800 underline dark:text-teal-300">
      All sessions
    </Link>
  );

  if (cached && signal?.client && can(me?.user.role, 'ws.assist')) {
    // Phase B 10: a P2 (extension) session mounts the mirror console instead of the video console.
    // Phase C 13.4: a P3 (native agent) session mounts the agent console.
    // Phase D section 13.4: every native tier (`p3_portable`, `p4_installed`) mounts the agent console.
    if (isNativeTier(cached.tier)) return <AgentConsole sessionId={id} signal={signal.client} cached={cached} helloReady={signal.hello !== null} deskLabel={cached.desk.label} capabilities={d?.deskClient?.capabilities ?? null} device={device} />;
    if (cached.tier === 'p2_extension') return <MirrorLiveConsole sessionId={id} signal={signal.client} cached={cached} helloReady={signal.hello !== null} deskLabel={cached.desk.label} />;
    return <LiveConsole sessionId={id} signal={signal.client} cached={cached} helloReady={signal.hello !== null} deskLabel={cached.desk.label} session={d} />;
  }
  if (detail.loading) return <Spinner label="Loading session" />;
  if (!d) return <Alert>{errorMessage(detail.error)}</Alert>;

  if (d.state === 'ended') {
    return (
      <>
        <PageHeader title={`Session with ${d.deskLabel ?? 'Desk'}`}>
          <StateBadge state={d.state} />
          {kindBadge}
          {back}
        </PageHeader>
        <EndedView detail={d} />
      </>
    );
  }

  if (d.state === 'knocked') {
    return (
      <>
        <PageHeader title={`Support request from ${d.deskLabel ?? 'Desk'}`}>{back}</PageHeader>
        <Card title="Waiting for a technician to accept">
          <KnockPanel sessionId={d.id} />
        </Card>
      </>
    );
  }

  const isAssist = d.assist.id === me?.user.id;
  if (isAssist && signal?.client) {
    if (isNativeTier(d.tier)) return <AgentConsole sessionId={id} signal={signal.client} cached={undefined} helloReady={signal.hello !== null} deskLabel={d.deskLabel ?? 'Desk'} capabilities={d.deskClient?.capabilities ?? null} device={device} />;
    if (d.tier === 'p2_extension') return <MirrorLiveConsole sessionId={id} signal={signal.client} cached={undefined} helloReady={signal.hello !== null} deskLabel={d.deskLabel ?? 'Desk'} />;
    return <LiveConsole sessionId={id} signal={signal.client} cached={undefined} helloReady={signal.hello !== null} deskLabel={d.deskLabel ?? 'Desk'} session={d} />;
  }

  return (
    <>
      <PageHeader title={`Session with ${d.deskLabel ?? 'Desk'}`}>
        <StateBadge state={d.state} />
        {kindBadge}
        {back}
      </PageHeader>
      <Card>
        <p className="text-sm">
          This session is handled by <strong>{d.assist.name}</strong> (state {humanise(d.state)}, accepted {fmtDateTime(d.acceptedAt)}).
          Joining another technician&apos;s live session (supervisor join) arrives in a later phase.
        </p>
      </Card>
    </>
  );
}
