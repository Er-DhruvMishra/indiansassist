/**
 * /room layout (contracts section 12): owns the Desk controller across `/room/new` and `/room/:sessionId`
 * so the socket survives the navigation. Missing `sessionStorage['ia.join.token']` redirects to /join.
 * On reload of `/room/:sessionId` the stored resumeKey re-attaches the Desk (section 7.5).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { STORAGE_KEYS } from '@indiansassist/shared';
import { Spinner } from '../components/ui';
import { JOIN_LABEL_KEY, readStore } from '../lib/storage';
import { DeskController, type DeskDeps } from './deskController';
import { RoomScreen } from './RoomScreen';

export type RoomTestDeps = Pick<DeskDeps, 'WebSocketImpl' | 'RTCPeerConnectionImpl' | 'getDisplayMedia' | 'getUserMedia' | 'pollMs'>;

function readResume(sessionId: string | undefined): { sessionId: string; resumeKey: string } | null {
  try {
    const raw = readStore('session', STORAGE_KEYS.roomResume);
    if (!raw) return null;
    const v = JSON.parse(raw) as { sessionId?: unknown; resumeKey?: unknown };
    if (typeof v.sessionId !== 'string' || typeof v.resumeKey !== 'string') return null;
    if (sessionId && sessionId !== 'new' && v.sessionId !== sessionId) return null;
    return { sessionId: v.sessionId, resumeKey: v.resumeKey };
  } catch {
    return null;
  }
}

export function RoomLayout({ testDeps }: { testDeps?: RoomTestDeps }) {
  const navigate = useNavigate();
  const location = useLocation();
  const token = readStore('session', STORAGE_KEYS.joinToken);
  const url = readStore('session', STORAGE_KEYS.joinSignal);
  const [ctrl, setCtrl] = useState<DeskController | null>(null);
  const initial = useRef({ sessionId: /^\/room\/([^/]+)/.exec(location.pathname)?.[1], testDeps });
  const navRef = useRef(navigate);
  navRef.current = navigate;
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;

  useEffect(() => {
    if (!token || !url) return;
    const c = new DeskController({
      url,
      token,
      deskLabel: readStore('session', JOIN_LABEL_KEY) || undefined,
      resume: readResume(initial.current.sessionId),
      onSession: (id) => {
        if (pathRef.current !== `/room/${id}`) navRef.current(`/room/${id}`, { replace: true });
      },
      ...initial.current.testDeps,
    });
    c.start();
    setCtrl(c);
    return () => c.dispose();
  }, [token, url]);

  if (!token || !url) return <Navigate to="/join" replace />;
  if (!ctrl) return <Spinner label="Connecting" />;
  return <RoomBound ctrl={ctrl} token={token} />;
}

function RoomBound({ ctrl, token }: { ctrl: DeskController; token: string }) {
  const snap = useSyncExternalStore(ctrl.subscribe, () => ctrl.snapshot);
  return <RoomScreen ctrl={ctrl} snap={snap} token={token} />;
}
