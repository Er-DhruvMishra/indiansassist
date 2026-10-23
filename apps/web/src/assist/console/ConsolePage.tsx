/**
 * /app/sessions/:id: decides between the live console (the caller is the accepting Assist), the knock
 * panel (still `knocked`), a read-only summary (someone else's live session, or a read-only role) and
 * the ended view. On reload the live console re-attaches with `assist.resume`.
 */
import { Link, useParams } from 'react-router';
import { useAuth } from '../../auth/AuthContext';
import { can } from '../../auth/permissions';
import { Alert, Card, PageHeader, Spinner } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { usePageTitle } from '../../hooks/usePageTitle';
import { errorMessage } from '../../lib/api';
import { sessionsApi } from '../../lib/endpoints';
import { fmtDateTime, humanise } from '../../lib/format';
import { StateBadge } from '../SessionsPage';
import { useAssistSignal } from '../signal/AssistSignalProvider';
import { KnockPanel } from '../signal/KnockPanel';
import { EndedView } from './EndedView';
import { LiveConsole } from './LiveConsole';

export function ConsolePage() {
  usePageTitle('Session console');
  const { id = '' } = useParams();
  const { me } = useAuth();
  const signal = useAssistSignal();
  const cached = signal?.takeCreated(id);
  const detail = useAsync(() => sessionsApi.get(id), [id]);
  const d = detail.data;

  const back = (
    <Link to="/app/sessions" className="text-sm font-medium text-teal-800 underline dark:text-teal-300">
      All sessions
    </Link>
  );

  if (cached && signal?.client && can(me?.user.role, 'ws.assist')) {
    return <LiveConsole sessionId={id} signal={signal.client} cached={cached} helloReady={signal.hello !== null} deskLabel={cached.desk.label} />;
  }
  if (detail.loading) return <Spinner label="Loading session" />;
  if (!d) return <Alert>{errorMessage(detail.error)}</Alert>;

  if (d.state === 'ended') {
    return (
      <>
        <PageHeader title={`Session with ${d.deskLabel ?? 'Desk'}`}>
          <StateBadge state={d.state} />
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
    return <LiveConsole sessionId={id} signal={signal.client} cached={undefined} helloReady={signal.hello !== null} deskLabel={d.deskLabel ?? 'Desk'} />;
  }

  return (
    <>
      <PageHeader title={`Session with ${d.deskLabel ?? 'Desk'}`}>
        <StateBadge state={d.state} />
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
