/**
 * The live-console hook of Phase E (docs/specs/phase-e-contracts.md sections 5.3a, 5.3b, 13.4, stream ai). When the
 * org policy includes the transcript, it sends the provider-specific notice once per session through the console's
 * ordinary chat path as soon as the session is live, keeps the post-notice chat and the playbook output tails (the
 * console's own snapshot, in memory only), redacts them with one RedactionState and uploads them when the session
 * ends. Nothing happens until the session's console controller registers (see liveConsoles.ts), and nothing is
 * fetched when the policy has no provider.
 */
import { useEffect } from 'react';
import {
  REGION_LABELS,
  newRedactionState,
  redactText,
  summaryTranscriptNotice,
  type AiPolicyReply,
  type AiProvider,
  type PackageTier,
  type SummaryTranscriptUpload,
} from '@indiansassist/shared';
import { watchLiveConsole, type LiveChatItem, type LiveConsoleHandle, type LiveRun } from './liveConsoles';
import { summaryApi } from './summaryApi';

/** What a live console knows about its session when it calls the hook. */
export type EnterpriseLiveSession = { sessionId: string; tier: PackageTier | null };

/** The notice of one session, kept in sessionStorage so a console reload does not send it twice. */
export type NoticeRecord = { msgId: string; at: number; provider: AiProvider };

const NOTICE_KEY = (sessionId: string) => `ia:sumnotice:${sessionId}`;
const MAX_MESSAGES = 500;
const MAX_OUTPUTS = 20;

export function loadNotice(sessionId: string): NoticeRecord | null {
  try {
    const raw = sessionStorage.getItem(NOTICE_KEY(sessionId));
    return raw ? (JSON.parse(raw) as NoticeRecord) : null;
  } catch {
    return null;
  }
}

function saveNotice(sessionId: string, n: NoticeRecord): void {
  try {
    sessionStorage.setItem(NOTICE_KEY(sessionId), JSON.stringify(n));
  } catch {
    /* storage unavailable: the notice may be sent again after a reload, never skipped */
  }
}

/** The last `max` characters of `s`, starting at a line boundary when one is near (the "last lines"). */
export function tailLines(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(-max);
  const nl = cut.indexOf('\n');
  return nl >= 0 && nl < max / 4 ? cut.slice(nl + 1) : cut;
}

/**
 * 5.3b: the upload body. Only messages at or after the notice (the notice itself included) are taken, in console
 * order, each dated no earlier than the notice (a Desk clock behind ours must not push a later message before it);
 * one RedactionState spans every message and then every playbook tail, in upload order.
 */
export function buildTranscriptUpload(
  notice: NoticeRecord,
  chat: readonly LiveChatItem[],
  runs: readonly LiveRun[],
): SummaryTranscriptUpload {
  const state = newRedactionState();
  const idx = chat.findIndex((c) => c.msgId === notice.msgId);
  const after = idx >= 0 ? chat.slice(idx) : chat.filter((c) => c.ts >= notice.at);
  const messages = after.slice(-MAX_MESSAGES).map((c) => ({
    from: c.from === 'assist' ? ('technician' as const) : ('user' as const),
    at: new Date(Math.max(c.ts, notice.at)).toISOString(),
    text: redactText(c.text, state).slice(0, 4000),
  }));
  const playbookOutputs = runs
    .filter((r) => /^[0-9a-f]{32}$/.test(r.runId))
    .slice(-MAX_OUTPUTS)
    .map((r) => ({
      runId: r.runId,
      stdoutTail: tailLines(redactText(tailLines(r.stdout, 4000), state), 4000),
      stderrTail: tailLines(redactText(tailLines(r.stderr, 2000), state), 2000),
    }));
  return { noticeSentAt: new Date(notice.at).toISOString(), noticeProvider: notice.provider, messages, playbookOutputs, consoleRedaction: 'redact-v1' };
}

/** The last upload per session, so the summary panel can send it again before a regenerate (5.3b). */
const lastUploads = new Map<string, SummaryTranscriptUpload>();
export function lastTranscriptUpload(sessionId: string): SummaryTranscriptUpload | null {
  return lastUploads.get(sessionId) ?? null;
}

type Policy = { reply: AiPolicyReply; regionLabel: string };

/** Drives one session's notice and upload against a registered console. Exported for tests. */
export function attachTranscriptHook(sessionId: string, handle: LiveConsoleHandle, loadPolicy: () => Promise<Policy | null>): () => void {
  let disposed = false;
  let notice = loadNotice(sessionId);
  let sending = false;
  let uploaded = false;
  let policy: Promise<Policy | null> | null = null;
  const policyOnce = () => (policy ??= loadPolicy().catch(() => null));

  const sendNotice = async () => {
    sending = true;
    const p = await policyOnce();
    if (disposed || notice || !p || p.reply.provider === 'none' || !p.reply.includeTranscript) return;
    let text: string;
    try {
      text = summaryTranscriptNotice(p.reply.provider, p.reply.anthropicAck?.scope ?? null, p.regionLabel);
    } catch {
      return; // anthropic without an acknowledgement: no transcript can be sent, so nothing to announce
    }
    const before = new Set(handle.snapshot.chat.map((c) => c.msgId));
    handle.sendChat(text);
    const item = handle.snapshot.chat.find((c) => !before.has(c.msgId) && c.text === text);
    notice = { msgId: item?.msgId ?? '', at: item?.ts ?? Date.now(), provider: p.reply.provider };
    saveNotice(sessionId, notice);
  };

  const upload = async () => {
    uploaded = true;
    const p = await policyOnce();
    if (!notice || !p || p.reply.provider === 'none' || !p.reply.includeTranscript) return;
    const body = buildTranscriptUpload(notice, handle.snapshot.chat, handle.snapshot.runs ?? []);
    lastUploads.set(sessionId, body);
    await summaryApi.uploadInput(sessionId, body).catch(() => undefined);
  };

  const onSnap = () => {
    const phase = handle.snapshot.phase;
    if (phase === 'live' && !notice && !sending) void sendNotice();
    if (phase === 'ended' && !uploaded) void upload();
  };
  const off = handle.subscribe(onSnap);
  onSnap();
  return () => {
    disposed = true;
    off();
  };
}

async function fetchPolicy(): Promise<Policy | null> {
  const reply = await summaryApi.policy();
  if (reply.provider === 'none' || !reply.includeTranscript) return { reply, regionLabel: '' };
  const caps = await summaryApi.capabilities();
  return { reply, regionLabel: REGION_LABELS[caps.region] };
}

export function useEnterpriseLiveHooks(session: EnterpriseLiveSession): void {
  const { sessionId } = session;
  useEffect(() => {
    let detach: (() => void) | null = null;
    const stop = watchLiveConsole(sessionId, (handle) => {
      detach?.();
      detach = handle ? attachTranscriptHook(sessionId, handle, fetchPolicy) : null;
    });
    return () => {
      stop();
      detach?.();
    };
  }, [sessionId]);
}
