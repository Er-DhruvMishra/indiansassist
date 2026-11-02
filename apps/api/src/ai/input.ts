/**
 * Phase E section 5.3: the summary input, built in the api from what the server already holds (the session row and
 * its audit chain) plus, only when the org policy allows it, the console's held transcript. People are labelled by
 * role, never by name; files by extension and size only; every text goes through one RedactionState (section 5.4)
 * before any provider sees it, after the transcript's own placeholders are reserved so numbering never collides.
 */
import {
  LIMITS,
  REDACTION_KINDS,
  SUMMARY_EVENT_ACTIONS,
  SUMMARY_PROMPT_VERSION,
  canonicalJson,
  canonicalJsonBytes,
  capSummaryInput,
  emptyRedactionCounts,
  newRedactionState,
  redactText,
  reservePlaceholders,
  sha256Hex,
  type ChainDigestEvent,
  type RedactionCounts,
  type RedactionKind,
  type SummaryPromptInput,
} from '@indiansassist/shared';
import {
  getPlaybookScoped,
  listAuditBySession,
  listSessionFiles,
  type AuditEntryRow,
  type Executor,
  type SessionRow,
} from '@indiansassist/db';
import type { HeldTranscript } from './transcript.js';

const EVENT_ACTIONS = new Set<string>(SUMMARY_EVENT_ACTIONS);
const EVENT_TEXT_MAX = 300;

type Data = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const words = (v: unknown): string => (typeof v === 'string' ? v.replace(/_/g, ' ') : 'unknown');

function seconds(ms: unknown): string {
  const n = num(ms);
  if (n === null) return '';
  const s = n / 1000;
  return s < 10 ? `${Math.round(s * 10) / 10} s` : `${Math.round(s)} s`;
}

/** `2.1 MB`, `340 KB`, `12 B` (decimal units). */
export function humanBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${Math.round(n / 100) / 10} KB`;
  if (n < 1_000_000_000) return `${Math.round(n / 100_000) / 10} MB`;
  return `${Math.round(n / 100_000_000) / 10} GB`;
}

/** The lower-case extension of a file name (letters and digits only, at most 10), or null. Never the name. */
export function fileExtension(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : null;
}

/** People by role (section 5.3): the console user is the technician, the Desk is the user. */
export function actorRole(row: Pick<AuditEntryRow, 'actorType'>): ChainDigestEvent['actor'] {
  switch (row.actorType) {
    case 'user':
      return 'technician';
    case 'desk':
      return 'user';
    case 'device':
      return 'device';
    default:
      return 'system';
  }
}

export type DigestLookups = {
  /** `${direction}:${fileId}` -> file name (session_file; only the extension is used). */
  files: Map<string, string>;
  /** playbook id -> catalogue name. */
  playbooks: Map<string, string>;
};

const sideName = (side: unknown): string => (side === 'assist' ? 'technician' : side === 'desk' ? 'user' : 'participant');

/** The per-action formatter of section 5.3 (unredacted; the caller redacts). Null for an action it does not read. */
export function formatChainEvent(row: Pick<AuditEntryRow, 'action' | 'data' | 'reason' | 'actorType'>, look: DigestLookups): string | null {
  const d = (row.data ?? {}) as Data;
  const reason = str(row.reason);
  const note = reason ? ` (note: ${reason})` : '';
  const playbook = (id: unknown): string => `"${(typeof id === 'string' && look.playbooks.get(id)) || 'a playbook no longer in the catalogue'}"`;
  switch (row.action) {
    case 'session.knock':
      return 'The user asked for support';
    case 'session.accepted':
      return 'The technician accepted the request';
    case 'session.denied':
      return 'The technician declined the request';
    case 'session.consent_granted': {
      const parts = [str(d.level) ? `level ${words(d.level)}` : null, str(d.scope) ? `scope ${words(d.scope)}` : null, num(d.monitors) !== null ? `${String(d.monitors)} monitor(s)` : null].filter(Boolean);
      return `The user granted consent${parts.length ? ` (${parts.join(', ')})` : ''}`;
    }
    case 'session.consent_revoked':
      return 'The user revoked consent';
    case 'session.started':
      return `The session started (connection ${words(d.path)})`;
    case 'session.resumed':
      return `The ${sideName(d.side)} reconnected`;
    case 'session.ended': {
      const dur = seconds(d.durationMs);
      return `The session ended: ${words(d.endReason)}${dur ? ` after ${dur}` : ''}${note}`;
    }
    case 'consent.level_changed':
      return `Consent level changed from ${words(d.from)} to ${words(d.to)}`;
    case 'consent.clipboard_changed':
      return `Clipboard sharing turned ${d.to === true ? 'on' : 'off'}`;
    case 'consent.monitors_changed':
      return `Shared monitors changed from ${String(num(d.from) ?? '?')} to ${String(num(d.to) ?? '?')}`;
    case 'session.path_changed':
      return `The connection path changed from ${words(d.from)} to ${words(d.to)}`;
    case 'file.sent':
    case 'file.received': {
      const name = look.files.get(`${String(d.direction)}:${String(d.fileId)}`);
      const ext = name ? fileExtension(name) : null;
      const size = num(d.bytes);
      const what = ext ? `a .${ext} file` : 'a file';
      return `${row.action === 'file.sent' ? 'Sent' : 'Received'} ${what}${size !== null ? ` (${humanBytes(size)})` : ''}`;
    }
    case 'recording.started':
      return 'Recording started';
    case 'recording.stored':
      return 'The recording was stored';
    case 'recording.failed':
      return `The recording failed (${words(d.reason)})`;
    case 'recording.deleted':
      return `A recording was deleted (${words(d.cause)})`;
    case 'recording.server_started':
      return 'The server recorder started';
    case 'recording.server_stopped':
      return `The server recorder stopped (${words(d.reason)})`;
    case 'elevation.requested':
      return reason ? `Requested elevation: ${reason}` : 'Requested elevation';
    case 'elevation.granted':
      return `Elevation was granted (administrator${d.mode === 'service' ? ', service mode' : ''})`;
    case 'elevation.denied':
      return `Elevation was denied (${words(d.cause)})`;
    case 'playbook.run_requested':
      return `Requested playbook ${playbook(d.playbookId)}${reason ? `: ${reason}` : ''}`;
    case 'playbook.run': {
      const exit = d.exit === null ? 'no exit code' : `exit ${String(num(d.exit) ?? '?')}`;
      const extra = [exit, seconds(d.durationMs), d.ranAs === 'admin' ? 'as admin' : 'as the user', d.truncated === true ? 'output truncated' : null, str(d.error) ? `error ${words(d.error)}` : null].filter(Boolean);
      return `Ran playbook ${playbook(d.playbookId)} (${extra.join(', ')})`;
    }
    case 'control.input':
      return `Remote input: ${String(num(d.count) ?? 0)} event(s) over ${seconds(d.windowMs) || 'a moment'}${num(d.refused) ? `, ${String(d.refused)} refused` : ''}`;
    case 'clipboard.sync':
      return `Clipboard synced: ${String(num(d.toDesk) ?? 0)} to the user, ${String(num(d.toAssist) ?? 0)} to the technician`;
    case 'tab.action':
      return `Browser tab action: ${words(d.kind)}${d.ok === false ? ' (failed)' : ''}`;
    case 'session.unattended_started': {
      const why = str(d.reason);
      return `Unattended session started (approved by ${words(d.approvedBy)})${why ? `: ${why}` : ''}`;
    }
    case 'capture.secure_desktop':
      return `The secure desktop (${words(d.surface)}) was shown for ${seconds(d.durationMs) || 'a moment'}`;
    case 'input.lock_changed':
      return `Local input ${d.locked === true ? 'locked' : 'unlocked'} (${words(d.cause)})`;
    case 'device.action_queued': {
      const why = str(d.reason);
      return `Device action queued: ${words(d.kind)}${why ? `: ${why}` : ''}`;
    }
    case 'device.action_dispatched':
      return `Device action dispatched: ${words(d.kind)}`;
    case 'device.action_cancelled':
      return `Device action cancelled: ${words(d.kind)}`;
    case 'device.action_started':
      return `Device action started: ${words(d.kind)} (approved by ${words(d.approvedBy)})`;
    case 'device.action_completed':
      return `Device action ${d.state === 'failed' ? 'failed' : 'completed'}: ${words(d.kind)}${num(d.exit) !== null ? ` (exit ${String(d.exit)})` : ''}`;
    case 'sec.verified':
      return 'The security code was verified';
    default:
      return EVENT_ACTIONS.has(row.action) ? words(row.action.replace('.', ' ')) : null;
  }
}

/** Cuts at a word boundary without splitting a placeholder. */
function cutEventText(s: string): string {
  if (s.length <= EVENT_TEXT_MAX) return s;
  let cut = s.slice(0, EVENT_TEXT_MAX - 1);
  const open = cut.lastIndexOf('[');
  if (open > cut.lastIndexOf(']')) cut = cut.slice(0, open);
  return `${cut.trimEnd()}…`;
}

export type ChainDigest = { events: { t: string; actor: ChainDigestEvent['actor']; text: string }[]; playbookRuns: Map<string, { playbook: string; exit: number | null }> };

/** Section 5.3: the session's audit entries in `SUMMARY_EVENT_ACTIONS`, formatted (unredacted), oldest first. */
export async function buildChainDigest(exec: Executor, session: SessionRow): Promise<ChainDigest> {
  const entries = (await listAuditBySession(exec, session.id)).filter((e) => EVENT_ACTIONS.has(e.action));
  const files = new Map<string, string>();
  for (const f of await listSessionFiles(exec, session.id)) files.set(`${f.direction}:${f.fileId}`, f.name);
  const playbooks = new Map<string, string>();
  for (const e of entries) {
    const id = (e.data as Data)?.playbookId;
    if (typeof id === 'string' && !playbooks.has(id)) {
      const pb = await getPlaybookScoped(exec, id, session.orgId);
      if (pb) playbooks.set(id, pb.name);
    }
  }
  const look = { files, playbooks };
  const events: ChainDigest['events'] = [];
  const playbookRuns: ChainDigest['playbookRuns'] = new Map();
  for (const e of entries) {
    const text = formatChainEvent(e, look);
    if (text === null) continue;
    events.push({ t: new Date(e.ts).toISOString(), actor: actorRole(e), text: text.slice(0, 600) });
    const d = e.data as Data;
    if (e.action === 'playbook.run' && typeof d.runId === 'string')
      playbookRuns.set(d.runId, { playbook: (typeof d.playbookId === 'string' && playbooks.get(d.playbookId)) || 'unknown playbook', exit: num(d.exit) });
  }
  return { events: events.slice(-LIMITS.summaryEventsMax), playbookRuns };
}

/** The `runId`s of the session's `playbook.run` entries (5.3c: only those are kept from an upload). */
export async function sessionRunIds(exec: Executor, sessionId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const e of await listAuditBySession(exec, sessionId)) {
    const runId = (e.data as Data)?.runId;
    if (e.action === 'playbook.run' && typeof runId === 'string') ids.add(runId);
  }
  return ids;
}

/** Placeholders of each kind present in a text (what the provider received, browser and api redactions alike). */
export function countPlaceholders(text: string): RedactionCounts {
  const counts = emptyRedactionCounts();
  const re = new RegExp(`\\[(${REDACTION_KINDS.join('|')})-\\d{1,9}\\]`, 'g');
  for (const m of text.matchAll(re)) counts[m[1] as RedactionKind] += 1;
  return counts;
}

export type BuiltInput = {
  input: SummaryPromptInput;
  inputSha256: string;
  /** Placeholders per kind in the final input. */
  redactions: RedactionCounts;
  /** The api's own new matches while building this input (the `ia_redactions_total` increments). */
  newRedactions: RedactionCounts;
  transcriptIncluded: boolean;
};

/**
 * Section 5.3: the redacted `SummaryPromptInput` of an ended session, capped at `LIMITS.summaryInputMaxBytes`. One
 * RedactionState spans the whole input: the held transcript's placeholders are reserved first, then the event texts
 * (with their reason columns) are redacted oldest first, then the transcript messages and playbook tails in upload order.
 */
export async function buildSummaryInput(exec: Executor, session: SessionRow, held: HeldTranscript | null): Promise<BuiltInput> {
  const digest = await buildChainDigest(exec, session);
  const state = newRedactionState();
  if (held) {
    for (const m of held.messages) reservePlaceholders(state, m.text);
    for (const p of held.playbookOutputs) {
      reservePlaceholders(state, p.stdoutTail);
      reservePlaceholders(state, p.stderrTail);
    }
  }
  const events: ChainDigestEvent[] = digest.events.map((e) => ({ t: e.t, actor: e.actor, text: cutEventText(redactText(e.text, state)) }));
  const transcript: SummaryPromptInput['transcript'] = held
    ? {
        messages: held.messages.map((m) => ({ from: m.from, at: m.at, text: redactText(m.text, state).slice(0, 4000) })),
        playbookOutputs: held.playbookOutputs.map((p) => {
          const run = digest.playbookRuns.get(p.runId);
          return {
            playbook: (run?.playbook ?? 'unknown playbook').slice(0, 200),
            exit: run?.exit ?? null,
            stdoutTail: redactText(p.stdoutTail, state).slice(-4000),
            stderrTail: redactText(p.stderrTail, state).slice(-2000),
          };
        }),
      }
    : null;
  const endedAt = session.endedAt ?? new Date();
  const raw: SummaryPromptInput = {
    v: 1,
    promptVersion: SUMMARY_PROMPT_VERSION,
    session: {
      tier: session.tier,
      startedAt: session.startedAt ? session.startedAt.toISOString() : null,
      endedAt: endedAt.toISOString(),
      durationMs: session.startedAt ? Math.max(0, endedAt.getTime() - session.startedAt.getTime()) : null,
      endReason: session.endReason ?? null,
      path: session.path,
      recorded: session.recordingStarted || session.serverRecording,
      unattended: session.unattended ?? null,
    },
    events,
    transcript,
    truncated: false,
  };
  const input = capSummaryInput(raw);
  return {
    input,
    inputSha256: sha256Hex(canonicalJsonBytes(input)),
    redactions: countPlaceholders(canonicalJson(input)),
    newRedactions: state.counts,
    transcriptIncluded: held !== null,
  };
}
