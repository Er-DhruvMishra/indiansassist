/**
 * Section 13.4 `PlaybookPanel`: the pinned catalogue of `session.created.agent.playbooks` (plus REST when truncated),
 * a parameter form per playbook, **Run** (REST `202` then the `playbook.run` op verbatim), the live stdout / stderr
 * of `pb.output`, exit / duration / ranAs from `pb.end`, **Cancel**. `requiresElevation` playbooks are disabled until
 * the level is `elevated`; `409 playbook_changed` explains itself.
 */
import { useState } from 'react';
import type { PlaybookArgValue, PlaybookManifest, PlaybookParam } from '@indiansassist/shared';
import { Alert, Badge, Button, Input, Select } from '../../../components/ui';
import { fmtDuration } from '../../../lib/format';
import type { PlaybookRun } from './agentState';

function initialArgs(params: PlaybookParam[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const p of params) {
    if (p.type === 'bool') out[p.name] = p.default ?? false;
    else if (p.default !== undefined) out[p.name] = String(p.default);
  }
  return out;
}

/** Form values to typed args (no coercion beyond the param type; the server validates). */
export function typedArgs(params: PlaybookParam[], values: Record<string, string | boolean>): Record<string, PlaybookArgValue> {
  const out: Record<string, PlaybookArgValue> = {};
  for (const p of params) {
    const v = values[p.name];
    if (v === undefined || v === '') continue;
    if (p.type === 'bool') out[p.name] = v === true;
    else if (p.type === 'int') out[p.name] = Number(v);
    else out[p.name] = String(v);
  }
  return out;
}

function ParamInput({ p, value, onChange }: { p: PlaybookParam; value: string | boolean | undefined; onChange: (v: string | boolean) => void }) {
  const id = `pb-param-${p.name}`;
  const label = `${p.label || p.name}${p.required ? ' (required)' : ''}`;
  if (p.type === 'bool')
    return (
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} /> {label}
      </label>
    );
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      {p.type === 'enum' ? (
        <Select id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose</option>
          {p.enum.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      ) : (
        <Input id={id} type={p.type === 'int' ? 'number' : 'text'} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

function RunView({ run, onCancel }: { run: PlaybookRun; onCancel: (runId: string) => void }) {
  const [tab, setTab] = useState<'stdout' | 'stderr'>('stdout');
  const end = run.end;
  return (
    <div className="flex flex-col gap-2 rounded border border-slate-200 p-2 dark:border-slate-700" data-testid={`run-${run.runId}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <strong>{run.name}</strong>
        {!end && !run.opError && <Badge tone="blue">Running</Badge>}
        {end && <Badge tone={end.exit === 0 && !end.error ? 'green' : 'red'}>{end.error ? end.error.replace(/_/g, ' ') : `exit ${end.exit}`}</Badge>}
        {end && <span className="text-xs">{fmtDuration(end.durationMs)}, ran as {end.ranAs}{end.truncated ? ', output truncated' : ''}</span>}
        {run.opError && <Badge tone="red">Refused by the Desk: {run.opError.replace(/_/g, ' ')}</Badge>}
        {!end && !run.opError && (
          <Button size="sm" variant="secondary" className="ml-auto" onClick={() => onCancel(run.runId)}>
            Cancel
          </Button>
        )}
      </div>
      <div role="tablist" className="flex gap-1 text-xs">
        {(['stdout', 'stderr'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} type="button" className={`rounded px-2 py-0.5 ${tab === t ? 'bg-slate-200 dark:bg-slate-700' : ''}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <pre role="tabpanel" aria-label={`${run.name} ${tab}`} className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2 font-mono text-xs text-slate-100">
        {run[tab] || (end ? '(no output)' : '')}
      </pre>
    </div>
  );
}

export function PlaybookPanel({
  playbooks,
  runs,
  elevated,
  canRun,
  supported,
  onRun,
  onCancel,
}: {
  playbooks: PlaybookManifest[];
  runs: PlaybookRun[];
  elevated: boolean;
  /** The secure channel is up and the console is at least at control. */
  canRun: boolean;
  /** The Desk advertises the `playbooks` feature. */
  supported: boolean;
  onRun: (pb: PlaybookManifest, args: Record<string, PlaybookArgValue>) => Promise<string | null>;
  onCancel: (runId: string) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = runs.some((r) => !r.end && !r.opError);
  if (!supported) return <p className="text-sm text-slate-600 dark:text-slate-400">This Desk does not run playbooks.</p>;
  return (
    <section aria-label="Playbooks" className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">Playbooks</h2>
      {playbooks.length === 0 && <p className="text-sm text-slate-600 dark:text-slate-400">No approved playbooks for this Desk.</p>}
      {error && <Alert>{error}</Alert>}
      <ul className="flex flex-col gap-2">
        {playbooks.map((pb) => {
          const needsElevation = pb.requiresElevation && !elevated;
          const open = openId === pb.id;
          return (
            <li key={pb.id} className="rounded border border-slate-200 p-2 dark:border-slate-700">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{pb.name}</span>
                <Badge>{pb.interpreter}</Badge>
                {pb.requiresElevation && <Badge tone="red">admin</Badge>}
                <Button
                  size="sm"
                  variant="secondary"
                  className="ml-auto"
                  disabled={needsElevation || !canRun}
                  title={needsElevation ? 'Request elevation first' : undefined}
                  onClick={() => {
                    setOpenId(open ? null : pb.id);
                    setValues(initialArgs(pb.parameters));
                    setError(null);
                  }}
                >
                  {open ? 'Close' : 'Run...'}
                </Button>
              </div>
              {pb.description && <p className="text-xs text-slate-600 dark:text-slate-400">{pb.description}</p>}
              {needsElevation && <p className="text-xs text-amber-700 dark:text-amber-300">Request elevation first</p>}
              {open && (
                <form
                  className="mt-2 flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setBusy(true);
                    setError(null);
                    void onRun(pb, typedArgs(pb.parameters, values)).then((err) => {
                      setBusy(false);
                      if (err) setError(err);
                      else setOpenId(null);
                    });
                  }}
                >
                  {pb.parameters.map((p) => (
                    <ParamInput key={p.name} p={p} value={values[p.name]} onChange={(v) => setValues((x) => ({ ...x, [p.name]: v }))} />
                  ))}
                  <Button type="submit" size="sm" disabled={busy || running}>
                    Run {pb.name}
                  </Button>
                </form>
              )}
            </li>
          );
        })}
      </ul>
      {runs.map((r) => (
        <RunView key={r.runId} run={r} onCancel={onCancel} />
      ))}
    </section>
  );
}
