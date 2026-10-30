/**
 * Playbook create / edit form (docs/specs/phase-c-contracts.md sections 8.1, 13.4): name, description, interpreter,
 * the body editor with the shared lint (warnings shown, a refused `cmd` body blocks saving), a parameters builder
 * that requires a `pattern` for strings, requiresElevation and the timeout.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { LIMITS, PLAYBOOK_INTERPRETERS, isSafePattern, lintPlaybookBody, type Playbook, type PlaybookParam } from '@indiansassist/shared';
import { Alert, Button, Field, Input, Select } from '../../components/ui';
import type { PlaybookBody } from '../../lib/agentApi';

type Draft = PlaybookBody & { body: string };

export function emptyDraft(): Draft {
  return { name: '', description: '', interpreter: 'powershell', body: '', requiresElevation: false, parameters: [], timeoutSec: 120 };
}

export function draftOf(p: Playbook): Draft {
  return {
    name: p.name,
    description: p.description,
    interpreter: p.interpreter,
    body: p.body ?? '',
    requiresElevation: p.requiresElevation,
    parameters: p.parameters,
    timeoutSec: p.timeoutSec,
    enabled: p.enabled,
  };
}

/** Client-side checks mirroring the server (section 8.1); the server stays authoritative. */
export function draftProblems(d: Draft): string[] {
  const out: string[] = [];
  if (d.name.trim().length < 1 || d.name.trim().length > 80) out.push('Name is 1 to 80 characters.');
  if (d.body.length === 0) out.push('The body is empty.');
  if (new TextEncoder().encode(d.body).length > LIMITS.playbookBodyMaxBytes) out.push('The body is larger than 64 KiB.');
  if (d.timeoutSec < 1 || d.timeoutSec > LIMITS.playbookTimeoutMaxSec) out.push(`Timeout is 1 to ${LIMITS.playbookTimeoutMaxSec} seconds.`);
  const names = new Set<string>();
  for (const p of d.parameters) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(p.name)) out.push(`Parameter "${p.name}": lower-case letters, digits and _.`);
    if (names.has(p.name)) out.push(`Parameter "${p.name}" appears twice.`);
    names.add(p.name);
    if (p.type === 'string' && !isSafePattern(p.pattern)) out.push(`Parameter "${p.name}" needs a valid pattern.`);
  }
  out.push(...lintPlaybookBody(d.interpreter, d.body).errors);
  return out;
}

function newParam(type: PlaybookParam['type']): PlaybookParam {
  if (type === 'string') return { name: 'value', label: 'Value', type, required: true, pattern: '[A-Za-z0-9 ._-]{1,64}' };
  if (type === 'enum') return { name: 'choice', label: 'Choice', type, required: true, enum: ['a', 'b'] };
  if (type === 'int') return { name: 'count', label: 'Count', type, required: false, min: 0, max: 100 };
  return { name: 'flag', label: 'Flag', type, required: false };
}

function ParamRow({ p, onChange, onRemove }: { p: PlaybookParam; onChange: (p: PlaybookParam) => void; onRemove: () => void }) {
  return (
    <div className="flex flex-wrap items-end gap-2 rounded border border-slate-200 p-2 dark:border-slate-700">
      <label className="flex flex-col text-xs">
        Name
        <Input value={p.name} onChange={(e) => onChange({ ...p, name: e.target.value })} className="w-32" />
      </label>
      <label className="flex flex-col text-xs">
        Label
        <Input value={p.label} onChange={(e) => onChange({ ...p, label: e.target.value })} className="w-40" />
      </label>
      <span className="text-xs">{p.type}</span>
      {p.type === 'string' && (
        <label className="flex flex-col text-xs">
          Pattern (required)
          <Input value={p.pattern} onChange={(e) => onChange({ ...p, pattern: e.target.value })} className="w-56 font-mono" />
        </label>
      )}
      {p.type === 'enum' && (
        <label className="flex flex-col text-xs">
          Values (comma separated)
          <Input value={p.enum.join(',')} onChange={(e) => onChange({ ...p, enum: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} className="w-56" />
        </label>
      )}
      <label className="flex items-center gap-1 text-xs">
        <input type="checkbox" checked={p.required} onChange={(e) => onChange({ ...p, required: e.target.checked })} /> required
      </label>
      <Button size="sm" variant="ghost" onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}

export function PlaybookEditor({ initial, onSave, onCancel }: { initial: Draft; onSave: (d: Draft) => Promise<string | null>; onCancel: () => void }) {
  const [d, setD] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lint = useMemo(() => lintPlaybookBody(d.interpreter, d.body), [d.interpreter, d.body]);
  const problems = draftProblems(d);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problems.length > 0) return;
    setBusy(true);
    setError(await onSave(d));
    setBusy(false);
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3" aria-label="Playbook editor">
      <Field label="Name">{(p) => <Input id={p.id} value={d.name} maxLength={80} onChange={(e) => setD({ ...d, name: e.target.value })} />}</Field>
      <Field label="Description">{(p) => <Input id={p.id} value={d.description} maxLength={500} onChange={(e) => setD({ ...d, description: e.target.value })} />}</Field>
      <Field label="Interpreter">
        {(p) => (
          <Select id={p.id} value={d.interpreter} onChange={(e) => setD({ ...d, interpreter: e.target.value as Draft['interpreter'] })}>
            {PLAYBOOK_INTERPRETERS.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Body" hint="Parameters reach the script as IA_PARAM_<NAME> environment variables; treat them as data.">
        {(p) => (
          <textarea
            id={p.id}
            aria-describedby={p.describedBy}
            rows={10}
            spellCheck={false}
            className="w-full rounded-md border border-slate-400 bg-white p-2 font-mono text-xs dark:border-slate-600 dark:bg-slate-950"
            value={d.body}
            onChange={(e) => setD({ ...d, body: e.target.value })}
          />
        )}
      </Field>
      {lint.warnings.length > 0 && (
        <Alert tone="amber">
          <ul className="list-disc pl-4">
            {lint.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      )}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Parameters</legend>
        {d.parameters.map((p, i) => (
          <ParamRow
            key={i}
            p={p}
            onChange={(np) => setD({ ...d, parameters: d.parameters.map((x, j) => (j === i ? np : x)) })}
            onRemove={() => setD({ ...d, parameters: d.parameters.filter((_, j) => j !== i) })}
          />
        ))}
        <div className="flex flex-wrap gap-1">
          {(['string', 'int', 'bool', 'enum'] as const).map((t) => (
            <Button key={t} size="sm" variant="secondary" disabled={d.parameters.length >= LIMITS.playbookParamsMax} onClick={() => setD({ ...d, parameters: [...d.parameters, newParam(t)] })}>
              Add {t}
            </Button>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={d.requiresElevation} onChange={(e) => setD({ ...d, requiresElevation: e.target.checked })} /> Requires administrator rights
      </label>
      <Field label="Timeout (seconds)">
        {(p) => <Input id={p.id} type="number" min={1} max={LIMITS.playbookTimeoutMaxSec} value={d.timeoutSec} onChange={(e) => setD({ ...d, timeoutSec: Number(e.target.value) })} />}
      </Field>
      {problems.length > 0 && (
        <Alert>
          <ul className="list-disc pl-4">
            {problems.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || problems.length > 0}>
          Save playbook
        </Button>
      </div>
    </form>
  );
}
