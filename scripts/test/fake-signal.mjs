// WebSocket half of the fake api (contracts section 7.3): one Assist and one Desk per session, enough for the
// smoke flow. Audit entries go through ctx.audit (shared appendEntry), so the chain is a real one.

import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

export function attachSignal(server, ctx) {
  const { st, shared, faults, audit } = ctx;
  const wss = new WebSocketServer({ noServer: true });
  ctx.wss = wss;
  const assists = new Set();

  server.on('upgrade', (req, socket, head) => {
    if (req.url.split('?')[0] !== '/signal' || req.headers.origin !== ctx.WEB_ORIGIN) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const user = ctx.userOf(req);
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = { ws, id: randomUUID(), user, role: user ? 'assist' : 'desk', token: null, session: null };
      ws.on('message', (raw) => onMessage(conn, JSON.parse(raw.toString('utf8'))));
      ws.on('close', () => assists.delete(conn));
    });
  });

  const send = (conn, msg) => conn?.ws.readyState === 1 && conn.ws.send(JSON.stringify(msg));
  const error = (conn, code, re) => send(conn, { t: 'error', code, message: code, ...(re ? { re } : {}) });
  const branding = (orgId) => ({ displayName: st.orgs.get(orgId).name, accentColor: null, logoData: null });
  const userActor = (u) => ({ id: u.id, label: u.name, type: 'user' });
  const deskActor = (s) => ({ id: s.deskRef, label: `desk:${s.deskRef.slice(0, 8)}`, type: 'desk' });
  const tail = (s) =>
    st.chains
      .get(s.orgId)
      .filter((e) => e.session_id === s.id)
      .at(-1)?.hash ?? null;

  function onMessage(conn, m) {
    const s = conn.session;
    switch (m.t) {
      case 'ping':
        return send(conn, { t: 'pong' });
      case 'assist.hello':
        assists.add(conn);
        return send(conn, {
          t: 'assist.hello.ok',
          re: m.id,
          connectionId: conn.id,
          user: { id: conn.user.id, name: conn.user.name, role: conn.user.role },
          region: 'in-mum',
        });
      case 'desk.hello': {
        const token = [...st.tokens.values()].find((t) => t.compact === m.token);
        if (!token || token.status !== 'active') {
          error(conn, token ? 'token_gone' : 'token_not_found', m.id);
          return conn.ws.close(4403);
        }
        conn.token = token;
        conn.deskLabel = m.deskLabel ?? 'Desk';
        for (const a of assists) send(a, { t: 'token.presence', tokenId: token.id, waiting: true, held: false });
        return send(conn, {
          t: 'desk.hello.ok',
          re: m.id,
          connectionId: conn.id,
          tokenId: token.id,
          tier: token.tier,
          technician: { name: token.createdBy.name },
          org: branding(token.orgId),
          region: 'in-mum',
        });
      }
      case 'desk.poll': {
        const matched = s && s.state !== 'knocked';
        return send(conn, {
          t: 'poll.status',
          re: m.id,
          state: matched ? 'matched' : 'waiting',
          ...(matched ? { sessionId: s.id, sessionState: s.state } : {}),
          technicianOnline: assists.size > 0,
        });
      }
      case 'desk.knock': {
        const t = conn.token;
        const now = Date.now();
        const sess = {
          id: randomUUID(),
          orgId: t.orgId,
          tokenId: t.id,
          deskRef: conn.id,
          state: 'knocked',
          desk: conn,
          assist: null,
          surface: null,
          startedAt: null,
        };
        st.sessions.set(sess.id, sess);
        conn.session = sess;
        audit(t.orgId, {
          action: 'session.knock',
          session_id: sess.id,
          actor: deskActor(sess),
          data: {
            tokenId: t.id,
            deskLabelHash: shared.sha256Hex(conn.deskLabel),
            userAgentHash: shared.sha256Hex('smoke'),
          },
        });
        const expiresAt = new Date(now + 120_000).toISOString();
        send(conn, {
          t: 'knock.ok',
          re: m.id,
          sessionId: sess.id,
          resumeKey: randomBytes(32).toString('base64url'),
          expiresAt,
        });
        for (const a of assists)
          send(a, {
            t: 'assist.knock',
            sessionId: sess.id,
            tokenId: t.id,
            tokenLabel: t.label,
            tokenCreatedBy: t.createdBy,
            deskLabel: conn.deskLabel,
            userAgent: null,
            knockedAt: new Date(now).toISOString(),
            expiresAt,
            canAct: true,
          });
        return undefined;
      }
      case 'assist.accept': {
        const sess = st.sessions.get(m.sessionId);
        if (!sess || sess.state !== 'knocked') return error(conn, 'bad_state', m.id);
        sess.assist = conn;
        conn.session = sess;
        sess.state = 'consent_pending';
        audit(sess.orgId, {
          action: 'session.accepted',
          session_id: sess.id,
          actor: userActor(conn.user),
          data: { tokenId: sess.tokenId, onBehalfOf: null },
        });
        const base = {
          t: 'session.created',
          sessionId: sess.id,
          tokenId: sess.tokenId,
          tier: 'p1_browser',
          state: 'consent_pending',
          consentState: 'pending',
          assist: { id: conn.user.id, name: conn.user.name },
          desk: { label: sess.desk.deskLabel },
          org: branding(sess.orgId),
        };
        send(conn, {
          ...base,
          polite: true,
          iceServers: [],
          iceTtl: 3600,
          iceExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        return send(sess.desk, { ...base, polite: false });
      }
      case 'webrtc.offer':
      case 'webrtc.answer':
      case 'webrtc.ice': {
        if (!s || s.id !== m.sessionId) return error(conn, 'forbidden', m.id);
        if (s.state !== 'active' && !faults.leakOfferBeforeConsent) return error(conn, 'consent_required', m.id);
        const { id: _id, ...relay } = m;
        return send(conn === s.desk ? s.assist : s.desk, relay);
      }
      case 'desk.consent': {
        if (!s || s.state !== 'consent_pending') return error(conn, 'bad_state', m.id);
        s.state = 'active';
        s.surface = m.surface ?? 'unknown';
        s.startedAt = new Date();
        st.tokens.get(s.tokenId).status = 'used';
        audit(s.orgId, {
          action: 'session.consent_granted',
          session_id: s.id,
          actor: deskActor(s),
          data: { surface: s.surface },
        });
        audit(s.orgId, {
          action: 'session.started',
          session_id: s.id,
          actor: { id: null, label: 'system', type: 'system' },
          data: { path: 'unknown' },
        });
        send(conn, {
          t: 'consent.ok',
          re: m.id,
          sessionId: s.id,
          state: 'active',
          consentState: 'granted',
          iceServers: [],
          iceTtl: 3600,
          iceExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        return send(s.assist, { t: 'consent.changed', sessionId: s.id, state: 'granted', surface: s.surface });
      }
      case 'session.end': {
        if (!s || s.id !== m.sessionId) return error(conn, 'forbidden', m.id);
        const endReason = conn === s.assist ? 'assist_ended' : 'desk_stopped';
        const endedAt = new Date();
        const durationMs = s.startedAt ? endedAt.getTime() - s.startedAt.getTime() : null;
        s.state = 'ended';
        audit(s.orgId, {
          action: 'session.ended',
          session_id: s.id,
          reason: m.note ?? null,
          actor: conn === s.assist ? userActor(conn.user) : deskActor(s),
          data: { endReason, durationMs, path: 'unknown' },
        });
        const ended = {
          t: 'session.ended',
          sessionId: s.id,
          endReason,
          endedAt: endedAt.toISOString(),
          startedAt: s.startedAt?.toISOString() ?? null,
          durationMs,
          hashChainTail: tail(s),
          assist: { id: s.assist.user.id, name: s.assist.user.name },
          surface: s.surface,
          recordingStarted: false,
          reachedActive: s.startedAt !== null,
        };
        send(s.assist, ended);
        send(s.desk, ended);
        s.desk.ws.close(4410);
        return undefined;
      }
      default:
        return error(conn, 'unknown_type', m.id);
    }
  }
}
