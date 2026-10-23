/**
 * One `/signal` socket for the whole Assist shell (contracts section 7). The accepting socket becomes
 * the session's Assist participant, so the console reuses this socket instead of opening its own.
 * Knock toasts, token presence and the `session.created` cache (accept races the console mount) live here.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { AssistHelloOk, AssistKnock, SessionCreated, SignalError } from '@indiansassist/shared';
import { ASSIST_SIGNAL_URL } from '../../config';
import { SignalClient, type SignalStatus } from '../../lib/signal';

export type Presence = { waiting: boolean; held: boolean };

export type AssistSignalValue = {
  client: SignalClient | null;
  status: SignalStatus;
  hello: AssistHelloOk | null;
  /** Increments on every `assist.hello.ok` (a reconnect re-runs `assist.resume`). */
  helloCount: number;
  knocks: AssistKnock[];
  presence: Record<string, Presence>;
  lastError: SignalError | null;
  announcement: string;
  takeCreated: (sessionId: string) => SessionCreated | undefined;
  accept: (sessionId: string) => void;
  deny: (sessionId: string, opts?: { revokeToken?: boolean; reason?: string }) => void;
};

const Ctx = createContext<AssistSignalValue | null>(null);

export function useAssistSignal(): AssistSignalValue | null {
  return useContext(Ctx);
}

export function AssistSignalProvider({
  enabled,
  children,
  url = ASSIST_SIGNAL_URL,
  WebSocketImpl,
}: {
  enabled: boolean;
  children: ReactNode;
  url?: string;
  WebSocketImpl?: typeof WebSocket;
}) {
  const navigate = useNavigate();
  const navRef = useRef(navigate);
  navRef.current = navigate;
  const [client, setClient] = useState<SignalClient | null>(null);
  const [status, setStatus] = useState<SignalStatus>('idle');
  const [hello, setHello] = useState<AssistHelloOk | null>(null);
  const [helloCount, setHelloCount] = useState(0);
  const [knocks, setKnocks] = useState<AssistKnock[]>([]);
  const [presence, setPresence] = useState<Record<string, Presence>>({});
  const [lastError, setLastError] = useState<SignalError | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const created = useRef(new Map<string, SessionCreated>());
  const pendingAccept = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) return;
    const c = new SignalClient({
      url,
      WebSocketImpl,
      onOpen: (cl) => cl.send({ t: 'assist.hello' }),
      onStatus: (s) => setStatus(s),
    });
    const offs = [
      c.on('assist.hello.ok', (m) => {
        setHello(m);
        setHelloCount((n) => n + 1);
        setKnocks([]);
      }),
      c.on('assist.knock', (m) => {
        setKnocks((list) => [...list.filter((k) => k.sessionId !== m.sessionId), m]);
        setAnnouncement(`${m.deskLabel ?? 'A Desk'} is asking for support on token ${m.tokenLabel ?? m.tokenId.slice(0, 8)}`);
      }),
      c.on('knock.closed', (m) => {
        setKnocks((list) => list.filter((k) => k.sessionId !== m.sessionId));
        if (m.by === 'accepted' && m.acceptedBy && !pendingAccept.current.has(m.sessionId))
          setAnnouncement(`${m.acceptedBy.name} accepted the support request`);
      }),
      c.on('token.presence', (m) => setPresence((p) => ({ ...p, [m.tokenId]: { waiting: m.waiting, held: m.held } }))),
      c.on('session.created', (m) => {
        created.current.set(m.sessionId, m);
        setKnocks((list) => list.filter((k) => k.sessionId !== m.sessionId));
        if (pendingAccept.current.delete(m.sessionId)) navRef.current(`/app/sessions/${m.sessionId}`);
      }),
      c.on('session.ended', (m) => {
        created.current.delete(m.sessionId);
        setKnocks((list) => list.filter((k) => k.sessionId !== m.sessionId));
        pendingAccept.current.delete(m.sessionId);
      }),
      c.on('error', (m) => setLastError(m)),
    ];
    c.connect();
    setClient(c);
    return () => {
      for (const off of offs) off();
      c.close();
      setClient(null);
      setHello(null);
    };
  }, [enabled, url, WebSocketImpl]);

  // Drop toasts whose 120 s knock window has passed (the server also sends knock.closed timeout).
  useEffect(() => {
    if (knocks.length === 0) return;
    const id = setInterval(() => {
      const now = Date.now();
      setKnocks((list) => {
        const next = list.filter((k) => new Date(k.expiresAt).getTime() > now);
        return next.length === list.length ? list : next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [knocks.length]);

  const accept = useCallback(
    (sessionId: string) => {
      if (!client) return;
      pendingAccept.current.add(sessionId);
      client.send({ t: 'assist.accept', sessionId });
    },
    [client],
  );

  const deny = useCallback(
    (sessionId: string, opts: { revokeToken?: boolean; reason?: string } = {}) => {
      if (!client) return;
      client.send({
        t: 'assist.deny',
        sessionId,
        ...(opts.reason ? { reason: opts.reason } : {}),
        ...(opts.revokeToken ? { revokeToken: true } : {}),
      });
      setKnocks((list) => list.filter((k) => k.sessionId !== sessionId));
    },
    [client],
  );

  const takeCreated = useCallback((sessionId: string) => created.current.get(sessionId), []);

  const value = useMemo<AssistSignalValue>(
    () => ({ client, status, hello, helloCount, knocks, presence, lastError, announcement, takeCreated, accept, deny }),
    [client, status, hello, helloCount, knocks, presence, lastError, announcement, takeCreated, accept, deny],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
